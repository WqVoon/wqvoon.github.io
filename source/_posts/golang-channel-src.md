---
title: 浅析 golang channel 源码
date: 2023-06-11 11:07:49
categories:
 - [Golang]
description: 分析 1.18.6 版本的 channel 源码，包括创建、写入、读取、关闭
---

# 前言

channel 是 golang 内置的用于协程间数据同步的工具，是 `make` 这个函数能创建的三种结构之一，具体语法有 `make(chan type)` 和 `make(chan type, size)` 两种。这两种方式的差异在于前者是无缓冲 channel，也就是说如果当前没有接受者，那么在发送者尝试向其中写入内容时会阻塞；后者的 size 则用于描述缓冲区的大小，在同样的场景下，前 size 次写入不会阻塞发送者。

另一方面，channel 可以和 golang 的 select 语句进行配合，从而实现一个协程监听多个 channel 的功能，而如果在 select 中设置了非阻塞的 default，那么不论在创建 channel 时是否设置了缓冲区，对其的读写都是非阻塞的。

本文从源码的角度来分析 channel 的实现，具体来说包括创建、写入、读取与关闭，在分析源码时只关注 channel 本身的主流程，所以会略过诸如静态检查、防重排序等内容。源码文件是 runtime/chan.go，这里包含了 golang 语法糖背后的秘密。

# 基础结构

在 chan.go 文件中，被定义的 channel 相关结构有两个，具体如下：

```go
type hchan struct {
  lock mutex // 保障 channel 的并发安全
  
  closed   uint32 // 当前 channel 是否已经关闭
  
  // 因读写当前 channel 而阻塞的协程列表
	recvq    waitq  // 因读而阻塞
	sendq    waitq  // 因写而阻塞
  
  // 下面字段与缓冲区相关
	qcount   uint           // 当前缓冲区中的元素数量，可以通过 len 函数获得
	dataqsiz uint           // 缓冲区能够容纳的元素数量，可以通过 cap 函数获得，一经创建不可修改
	buf      unsafe.Pointer // 缓冲区对应内存的首地址
  sendx    uint   // 缓冲区中的写入指针
	recvx    uint   // 缓冲区中的读取指针
	elemsize uint16 // 缓冲区中单个元素的大小，实际上是 elemtype.size 的值
  elemtype *_type // 缓冲区中的元素类型
}

type waitq struct {
	first *sudog
	last  *sudog
}
```

当我们在代码中通过 make 来创建一个 channel 时，实际拿到的结构是 hchan 的指针，这个结构中记录了 channel 本身的元信息，比如缓冲区大小、缓冲区内存首地址、channel 中元素的类型等。channel 的各种操作都依赖于这些信息，而 channel 本身又是并发安全的，所以有 lock 这个锁结构来保证这一点。

另一方面，创建 channel 时可能会被要求创建数据的缓冲区，这块缓冲区被实现成循环队列，是一块以 `hchan.buf` 为首的、`hchan.dataqsize * hchan.elemtype.size` 大小的连续内存，读写指针被保存在 `hchan.recvx` 和 `hchan.sendx` 中。

最后，在阻塞地读写 channel 时都可能会因为不满足读写条件而导致当前协程被挂起，挂起时需要保存与协程相关的 channel 上下文，比如在尝试读写哪个 channel，数据的源地址和目标地址等，这些内容被定义在 `runtime.sudog` 结构中。而同一个 channel 在同一时间有可能导致多个协程的阻塞，比如多个发送者同时向一个满 channel 中写入数据，那么它们就都会阻塞，这就需要 channel 能以列表的形式保存所有因它而阻塞的协程，对应到代码中就是 `hchan.recvq` 和 `hchan.sendq` 这两个字段，前者保存因读而阻塞的协程列表，后者保存因写而阻塞的协程列表，两者都是 waitq 类型，这是一个双向链表。

# 创建

channel 的创建最终会由 runtime.makechan 这个函数来完成，如前所述，这个函数的最终目的是按使用者的需求在堆上创建一个对应的 hchan 结构，然后将这个结构的指针返回，所以整体流程并不复杂。

makechan 在创建 hchan 结构时，根据入参的不同有三种分配方式：

```go
	var c *hchan
	switch {
	case mem == 0: // 不需要缓冲区
		c = (*hchan)(mallocgc(hchanSize, nil, true))
		c.buf = c.raceaddr()
	case elem.ptrdata == 0: // 缓冲区中的数据类型是非指针类型
		c = (*hchan)(mallocgc(hchanSize+mem, nil, true))
		c.buf = add(unsafe.Pointer(c), hchanSize)
	default: // 需要缓冲区，且缓冲区中的数据类型是指针类型
    c = new(hchan) // 对应 runtime.newobject，等价于 mallocgc(hchanSize, typeOf(hchan), true)
		c.buf = mallocgc(mem, elem, true)
	}
```

- 如果 size 为 0，也就是当前的 channel 不需要缓冲区，那么直接分配一个 hchan 大小的内存即可，这块内存只用于承载 hchan 中的数据
- 如果 channel 中保存的数据类型不是指针类型，那么分配一块大内存，前半部分保存 hchan，后半部分用来作为缓冲区，同时把后半部分的首地址放在 `hchan.buf` 字段中
- 如果 channel 中保存的数据类型是指针类型，那么分配两块内存，分别用来保存 hchan 和缓冲区

我没有研究过 golang 的内存分配模型，但从代码上看可以发现前两个分支都不涉及“指针类型数据的缓冲区”，在调用 mallocgc 时第二个参数传递了 nil，而拥有指针类型数据的缓冲区的 channel 则用数据类型作为 mallocgc 的第二个参数（new 这个内置函数对应 `runtime.newobject` 函数，本质也是调用了 mallocgc），猜测第二参数可以辅助决定是否需要 gc 来扫描这块内存。

# 写入

channel 的写入最终由 runtime.chansend 这个函数来完成，这个函数整体比较长，但 channel 本身相关的内容并不多。chansend 的函数签名被定义成 `func chansend(c *hchan, ep unsafe.Pointer, block bool, callerpc uintptr) bool`，第一个参数是发送数据的目标 channel，第二个参数是被发送数据的源地址，第三个参数代表本次写入是否阻塞（如果配合了 select-default 那么就是非阻塞的），第四个参数与主流程无关，可以忽略，返回值是一个 bool 类型，代表这次写入是否成功，这个返回值是给 select 的分支选择来用的。

下面来分析代码，chansend 首先判断了目标 channel 是否为 nil，如果在 select-default 中向 nil 中发送数据，那么直接返回 false 跳过对应的 case 分支，而如果是在阻塞流程中发送数据，那么当前协程将会永远阻塞：

```go
	if c == nil {
		if !block {
			return false
		}
		gopark(nil, nil, waitReasonChanSendNilChan, traceEvGoStop, 2)
		throw("unreachable")
	}
```

在确保 c 不是 nil 后，我们就可以认为这次的发送是一个合理的调用，那么通常来说我们就应该对这个 channel 加锁，然后进行内部字段的变动。但 golang 为了加速 select 环境下写入时的分支判断，在加锁前首先判断了一下当前 channel 是否已满，如果满了就提前返回 false 避免锁开销，对应的语句是 `if !block && c.closed == 0 && full(c) {return false}`。在这其中，full 函数的实现是这样的：

```go
func full(c *hchan) bool {
	if c.dataqsiz == 0 {
    // 如果当前 channel 没有缓冲区，那么判断当前是否有等待读取数据的协程，没有则说明本次写入会导致当前协程阻塞
		return c.recvq.first == nil
	}
  // 如果有缓冲区，那么判断缓冲区是否已满，满则说明本次写入会导致当前协程阻塞
	return c.qcount == c.dataqsiz
}
```

如果浅试一下后发现可以写入，那么此时才对当前 channel 进行加锁，加锁后做的第一件事情就是判断当前 channel 是否关闭，因为尽管加锁前判断过 channel 未关闭，但这仍不能确定当前协程获取到锁以后 channel 的状态是什么样的。如果一个协程向关闭的 channel 中写入数据，那么程序会 panic。

然后，chansend 会尝试从 `hchan.recvq` 中获取一个协程，如果能获取到，那么说明有协程在等待从当前 channel 中读取数据，此时调用 `runtime.send` 将数据发给对应的协程。我们前面提到 `hchan.waitq` 中保存的是 `runtime.sudog` 的双向链表，而后者中保存了与当前 channel 相关的上下文，在发送数据的这个场景下，`sudog.elem` 保存了读取到的内容应该保存在哪里，比如 `val <- c` 这个语句下，val 的地址就会被保存在 `sudog.elem` 中，而这里所谓的“发送”，其实就是将 chansend 入参中的 ep 这个指针内保存的数据复制到 `sudog.elem` 对应的内存里。此外，由于此时这个准备接收数据的协程已经拿到了它需要的内容，发送方还要调用 `runtime.goready` 来将对应协程加入到协程的调度队列中，这样对应的协程才有机会被运行到。

通过与我们后面描述的读取过程相配合，我们在写入时可以假设如果从 `hchan.recvq` 中获取到了协程，那么当前的 channel 缓冲区中一定是没有数据的。反过来说，如果没能获取到协程，那么在 `hchan.lock` 的保护下，我们可以放心地向缓冲区中写入数据。在写入时需要先通过比较 `hchan.qcount` 和 `hchan.dataqsiz` 的大小来判断缓冲区是否已满，未满时直接将数据拷贝到缓冲区就完成了这次的写入过程。

另一方面，如果缓冲区已满，或者这个 channel 本身没有缓冲区时，就意味着当前的协程应该阻塞直至这个 channel 可以被写入。这里的阻塞本质上就是把当前协程挂在其等待的 channel 上，并让 golang 的调度器不能访问到它，当 channel 可以被写入时，由其他的协程来唤醒当前协程。我们前面看到因为读取而阻塞的协程可能会被执行写入的协程唤醒，那么反过来，因写入而阻塞的协程就是被执行读取的协程唤醒的。

但是在陷入阻塞之前，还需要先判断一下入参的 block 是否为 true，并按需提前结束当前函数，从而实现非阻塞写入。协程在执行 `gopark` 函数时会陷入阻塞，当被唤醒时会继续执行 `gopark` 之后的内容，通过继续阅读源码我们会发现，协程只是做了一些收尾判断工作，尽管在陷入阻塞前 `sudog.elem` 中会被写入待发送数据的地址，但陷入阻塞的协程在被唤醒后并没有继续使用这个参数来做什么，我们从读取 channel 部分的代码可以看到，因为这个参数已经被负责从 channel 中读取数据的协程用掉了。

# 读取

channel 的读取最终由 `chanrecv` 这个函数来完成，入参的含义与写入时相同，所不同的是返回值有两个，第一个与写入时一样代表当本次操作是某个 select 语句中的一个 case 时，经历内部的一系列判断后是否被外面的 select 语句选择到，后者则代表本次读取是否成功读到了值。

读取的过程整体上与写入是类似的，首先对于 nil 的读取在非阻塞读取时会直接返回，阻塞读取时会导致永远阻塞。然后在经历 fast-path 判断后，当确实要对 channel 进行写入时会通过 `hchan.lock` 来保证并发安全。读取操作首先会从 `hchan.sendq` 中尝试获取一个协程，如果能获取到，那么就说明当前 channel 一定是空。此时调用 `recv` 函数来完成具体的传递逻辑。

```go
	if c.dataqsiz == 0 {
    // 无缓冲 channel，应该将“因写入而阻塞的协程”携带的数据（sudog.elem）作为目标数据
		if raceenabled {
			racesync(c, sg)
		}
		if ep != nil {
			// ep 是读取到的数据应该写入的地址
			recvDirect(c.elemtype, sg, ep)
		}
	} else {
		// 如果 channel 有缓冲但仍执行到了这里，也就是当前有“因写入而阻塞的协程”，那么说明缓冲区一定满了，
    // 此时应该从缓冲区头部取出数据作为目标数据，并把“因写入而阻塞的协程”携带的数据放进缓冲区，
    // 这样就可以保障 channel FIFO 的特性
		qp := chanbuf(c, c.recvx)
		...
		// 这里按理说不应该出现 ep == nil 的情况，这里可能是为了 double check
		if ep != nil {
			typedmemmove(c.elemtype, ep, qp)
		}
		// 把“因写入而阻塞的协程”携带的数据放进缓冲区
		typedmemmove(c.elemtype, qp, sg.elem)
		c.recvx++
		if c.recvx == c.dataqsiz {
			c.recvx = 0
		}
		c.sendx = c.recvx // c.sendx = (c.sendx+1) % c.dataqsiz
	}
```

从上面的代码也可以发现，不论最终流程走到了 if 还是 else，从 `hchan.sendq` 中获取到的协程所携带的数据都被转移走了，所以正如我们前面在讨论写入流程时提到过的，`hchan.sendq` 中的协程被唤醒后不需要再对 `sudog.elem` 做什么处理。

另一方面，如果没能从 `hchan.sendq` 中获取到协程，那么就需要尝试从缓冲区中获取数据，具体而言是判断 `hchan.qcount` 是否大于 0，如果这个条件成立那么说明缓冲区中存在数据，此时将内容拷贝出来并按需调整缓冲区的相关字段，然后就可以结束读取的过程了。

但如果缓冲区也没有数据，那就代表当前协程没办法从 channel 中获取数据，它首先应该释放 `hchan.lock` 来给其他协程提供写入的机会，另一方面，根据 block 入参的取值，还需要分情况处理。如果这个值为 false，那么当前读取流程就应该直接退出，反过来说如果为 true，那么将当前协程阻塞。与写入过程相同，在当前协程下次被唤醒后也不需要对 `hchan.elem` 做什么处理，因为它是给写入过程用的，这部分内容我们在上文也已经讨论过了，这里就不再赘述。

# 关闭

channel 的关闭通过 `closechan` 函数来实现，这个函数首先对 channel 本身做了一些判断，如果 channel 为 nil 或已经关闭过了（`hchan.closed` 不为 0），那么会直接 panic。在这之后，它会从 `hchan.recvq` 和 `hchan.sendq` 中获取所有阻塞中的协程，然后依次唤醒它们。

虽然代码中同时处理了这两个双向链表，但实际上对于一个 channel 而言，不会出现两个链表都不为空的情况。因为 closechan 在遍历这两个链表和唤醒它们时会先对 `hchan.lock` 加锁，所以在它执行这些逻辑的过程中 channel 的状态不会再发生变化。如果 `hchan.recvq` 上有内容，那么说明此时 channel 的缓冲区中一定没有数据，或者根本没有缓冲区，此时协程被唤醒时 `sudog.elem` 对应的地址中并没有被写入内容，所以使用方会拿到对应类型的零值；而如果 `hchan.sendq` 上有内容，那么当这些协程被唤醒时是想向关闭的 channel 中写入数据的，此时会导致 panic。

关闭 channel 后缓冲区中仍然可能有内容，因为 closechan 并没有处理缓冲区中的内容。所以此时如果有协程想从其中读取内容，那么这仍然是有效的，`chanrecv` 会从缓冲区中正常的拿到所需的数据。