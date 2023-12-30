---
title: bytedance channel wrapper 源码解读
date: 2023-12-30 19:59:57
categories:
 - [Golang]
description: 解读 GitHub 上 bytedance/gopkg 中的 channel wrapper 相关源码
---

# 前言

现代应用中，多线程或更轻量的多协程编程是必不可少的。不论是线程还是协程，都是一个个可以被调度的执行单元，为了让这些执行单元能够协同起来一起完成任务，就需要跨单元来传递一些数据，而这不可避免地会带来数据竞争的问题。为了解决数据竞争，大多数的编程语言采用了加锁的方式来让一部分代码在同一时间只能被一个执行单元访问到，由此来构成安全区；golang 在语言层面则采用了不一样的方法（标准库也提供了协程级别加锁的能力），它的哲学是“不要通过共享内存来通信，而应该通过通信来共享内存”，而它提供的通信方案正是 channel。

之前我写过一篇[博客](https://wqvoon.github.io/2023/06/11/golang-channel-src/)来解读 golang 原生 channel 的源码，我个人认为它的设计是非常优雅的。不过虽然从使用方式上它足够简单易用，但事实上它并不是一个生产友好的组件，如果使用不当很有可能造成应用的安全隐患。

# 原生 channel 的一些问题

Golang 中的 channel 通过内置的 make 关键字来初始化，在初始化时除了可以提供需要传递的元素类型，还可以提供一个非必需的容量。这个容量会将 channel 区分成阻塞式和非阻塞式的，前者当且仅当有协程在从 channel 中读取数据时，尝试写入的协程才不会阻塞；后者则提供一个 buffer，在 buffer 还没有被充满时，尝试向 channel 写入内容的协程不会阻塞（这是站在写入方的角度，反过来站在读取方的角度也是一样的）。阻塞的 channel 通常被用于实现一次性通知，比如 context 的取消、优雅退出等功能，这些场景都比较简单，使用中也不会有什么大问题。

而与阻塞 channel 不同，非阻塞的 channel 通常被实现生产-消费模型，这与具体的业务场景息息相关且灵活多变，稍不注意就可能产生问题。我们来想象一个场景，假设我们有一个服务，对外提供一个接口 SubmitTask 用于提交一个可以稍后被执行的任务。那么 channel 就可以作为一个技术选型，比如每次请求来的时候向 channel 中写入一个任务的上下文就返回，然后应用中有一个后台的协程从 channel 中消费任务并做具体的处理。

这里这个后台协程处理 channel 中元素的方式就可以分为同步和异步两种。所谓同步指的是后台协程自己完全接管从 channel 中取任务和执行任务的工作，而与之相对的，异步指的是每次收到一个或几个任务后就起一个新的协程来处理，这样做的好处在于负责消费 channel 的协程就不会因为忙于处理任务而一段时间无法消费 channel 中的元素，导致写入方在写入时阻塞。异步处理的隐患在于，消费时启动的新协程的数量取决于 channel 中 buffer 的长度和写入方的写入速度，而这两点其实都不靠谱，比如写入速度是完全取决于业务场景的，在我们的例子中有可能因为峰值流量导致写入速度瞬间增加，而 buffer 的长度又是一个经验性的取值，且 channel 一旦创建就不可修改，那么如果取大了就会让任务协程的数量完全取决于写入流量，取小了又会退回成阻塞式 channel，写入方就会受到影响。

由此可见，原生 channel 会有这个问题的重要原因在于，控制写入和读取流量的方式对于一个 channel 而言是静态的，而在实际环境中通常是需要动态调整的。虽然我们也可以通过 select+default 的方式来避免完全阻塞或让写入方丢弃一些消息来降低读取方的消费压力，但这些细节其实也比较容易出错且有必要为了复用而直接封装到组件里，后面我们会看到本次阅读的 channel wrapper 就具备这样的能力。

另一方面，上面的描述也引出了原生 channel 的另一个问题，就是不支持丢弃元素。这看起来是一件好事，但实际上在消费不及时的情况下，丢弃一些元素来让更多的元素能够被处理是非常重要的手段。还是回到上面 SubmitTask 的例子里，假设我们的任务是有时效性的，在消费不及时的情况下可能取到的任务已经没必要处理了，此时直接丢弃掉已经无效的元素，快速将消费进度拉齐到此时需要被处理的元素才是正确的做法。

最后，原生 channel 的关闭不是幂等的，重复关闭同一个 channel 得到的不是报错，而是直接崩溃退出；与之类似的，向一个已经关闭的 channel 写入内容也不会得到报错，同样也是崩溃退出。而这两点都是很容易被写出的代码，却不容易被测试覆盖到，因为这是运行时错误。

# 源码解读

> 源码文件：https://github.com/bytedance/gopkg/blob/a5eedbe/lang/channel/channel.go

## 基本结构

golang 目前还没有提供语法层面的元编程能力（类似 Vue 那种用语言支持的语法实现更多功能的能力），所以如果要增强 channel 的能力，我们只能在原生 channel 上包装一个结构体并增加一些方法，而不能直接修改 <- 或 -> 操作符的行为。channel wrapper （后面简称 cw）提供了如下的接口：

```go
// Channel is a safe and feature-rich alternative for Go chan struct
type Channel interface {
	// Input send value to Output channel. If channel is closed, do nothing and will not panic.
	Input(v interface{})
	// Output return a read-only native chan for consumer.
	Output() <-chan interface{}
	// Len return the count of un-consumed items.
	Len() int
	// Stats return the produced and consumed count.
	Stats() (produced uint64, consumed uint64)
	// Close closed the output chan. If channel is not closed explicitly, it will be closed when it's finalized.
	Close()
}
```

这里的方法除了 Stats 外都是原生 channel 也能提供的，但是以语法层面及编译器支持的方式来提供的，所以如果要将原生 channel 迁移到这里的 channel wrapper 还是有一些改造成本的。

回到源码本身，cw 提供了一个默认的接口实现：

```go
// channel implements a safe and feature-rich channel struct for the real world.
type channel struct {
	size             int // channel 的大小，如果 nonblock 为 true 那么这个字段无意义
	state            int32 // 标识 channel 是否已经关闭
	consumer         chan interface{} // 从这里读取元素
	nonblock         bool // 是否启用非阻塞模式，非阻塞模式下 buffer 的大小取决于内存
	timeout          time.Duration // 内部元素的最大生存时间，超过时会被吊起
	timeoutCallback  func(interface{}) // 如果超时会被调用的方法
	producerThrottle Throttle // Input 时的 throttle，是一个函数，所以可以做到动态调整
	consumerThrottle Throttle // Output 时的 throttle，和 Input 相同
	throttleWindow   time.Duration // 如果上面的两个 throttle 命中，那么隔多久再去调用一次
	// statistics
	produced uint64 // item already been insert into buffer
	consumed uint64 // item already been sent into Output chan
	// buffer
	buffer     *list.List // 用这个结构来记录写入后尚未被处理的元素
	bufferCond *sync.Cond
	bufferLock sync.Mutex
}
```

## 创建/关闭

虽然上面的 channel 结构实现了 Channel 接口，但最后被使用的并不是这个结构，而是另一个名为 channelWrapper 的结构：

```go
// channelWrapper use to detect user never hold the reference of Channel object, and runtime will help to close channel implicitly.
type channelWrapper struct {
	Channel
}
```

为什么要包装这样一个结构呢？首先使用 Channel 接口可以在后面升级时不修改业务代码就将其替换成另一个具体的实现，而 channelWrapper 在此基础上再次包装了 Channel 接口，是为了能实现自动关闭 channel 的功能。具体来说，cw 可以由用户主动来关闭 channel，也可以在创建出来的 channel 不被引用时自动被关闭。和原生 channel 不同，cw 的关闭并不是可选的，因为它在初始化时会启动一个后台的协程来消费 channel 中的元素，那么当 cw 整体不可用时这个被启动的协程也应当被随之销毁；另一方面，和原生 channel 相同，关闭 cw 会通知尝试从中读取内容的协程。

下面来看创建和关闭的代码：

```go
// New 用于创建一个 channel wrapper，对外返回的是 Channel 接口，方便后面替换其他实现
func New(opts ...Option) Channel {
  // 创建一个 channel 结构体，并初始化内部结构
	c := new(channel)
	c.size = defaultMinSize
	c.throttleWindow = defaultThrottleWindow
	c.bufferCond = sync.NewCond(&c.bufferLock)
	for _, opt := range opts {
		opt(c)
	}
	c.consumer = make(chan interface{})
	c.buffer = list.New()
  // 启动后台的消费协程
	go c.consume()

	// 创建一个 channelWrapper 来包装上面的 channel
	cw := &channelWrapper{c}
  // 为这个 cw 注册一个 Finalizer，因为 Channel 是一个接口，本质上是一个指针，
  // 所以 cw 是一个包含指针的结构体，那么 SetFinalizer 就不会被编译器优化掉
	runtime.SetFinalizer(cw, func(obj *channelWrapper) {
		// 对应的 Finalizer 函数就是调用上面创建的 channel 的 Close 方法，
    // 后面会看到，Close 是幂等的，所以即便用户此前已经关闭过，这里的关闭也不会导致崩溃
		obj.Close()
	})
	return cw
}

// Close 用于优雅关闭一个 channel wrapper
func (c *channel) Close() {
  // 如果当前的 cw 已经关闭，那么直接退出即可，这里来保证 Close 方法是幂等的
	if !atomic.CompareAndSwapInt32(&c.state, 0, -1) {
		return
	}
	// stop consumer
	c.bufferLock.Lock()
	c.buffer.Init() // 清空 buffer 对应的内存，并将长度置零，消费者协程会因此而判断当前是否应该完全停止消费
	c.bufferLock.Unlock()
	c.bufferCond.Broadcast() // 通知所以等待在 bufferCond 的协程，其中就包含消费者协程
}
```

## 读取

虽然 cw 对外提供了 Output 方法，但实际上它的实现非常简单：

```go
func (c *channel) Output() <-chan interface{} {
	return c.consumer
}
```

从上面的结构体描述中我们可以看到，这个字段是一个原生 channel，但它的内容并不直接来源于 Input 的输入，而是经过 cw 处理后的结果，具体来说，是被 New 方法创建的后台消费协程来处理的：

```go
func (c *channel) consume() {
  // 只要 cw 不关闭，处理就不停止
	for {
		// 是否应该被限流，后面我们会看到，这个 throttling 返回 true 代表当前 cw 已经被关闭了，
    // 这里直接退出即可
		if c.throttling(c.consumerThrottle) {
			return
		}

		c.bufferLock.Lock()
    // 这里的长度为零可能是因为被调用了 Close，因为 c.buffer.Init() 会清零长度，
    // 也可能因为当前还没有任何协程向其中写入了内容
		for c.buffer.Len() == 0 {
			if c.isClosed() { // 如果 cw 被关闭了
				close(c.consumer) // 那关闭 consumer channel，此时所有的 Output 都会直接返回，对齐原生 channel 的行为
				atomic.StoreInt32(&c.state, -2) // -2 means closed totally
				c.bufferLock.Unlock()
				return // 退出当前的后台协程
			}
			c.bufferCond.Wait() // 等待信号量，如果有协程写入这里会被 Signal 唤醒
		}
    
    // 能执行到这里说明一定会取到一个元素
		it, ok := c.dequeueBuffer()
		c.bufferLock.Unlock()
		c.bufferCond.Broadcast() // 通知负责写入的协程，当前 buffer 有空位，可以继续写入，这里只对 nonblock 为 false 的 cw 有效
		if !ok {
			// in fact, this case will never happen
			continue
		}

		// 如果拿出的元素已经过期了，那么跳过这个元素继续消费下一个
		if it.IsExpired() {
			if c.timeoutCallback != nil {
				c.timeoutCallback(it.value)
			}
			atomic.AddUint64(&c.consumed, 1)
			continue
		}
		// 向 consumer channel 中写入刚刚消费到的内容，此时上面的 Output 会返回这个内容
		c.consumer <- it.value
		atomic.AddUint64(&c.consumed, 1)
	}
}
```

## 写入

从上面读取部分的代码可以看到，尽管 cw 提供了 nonblock 模式，但消费部分完全没有区分是否是 nonblock。这也比较合理，因为根据消费协程的实现，只要 buffer 中有数据就不会阻塞在“取数”的环节，而如果 buffer 中没数据，本身就是应该阻塞在这个环节的。

但写入不同，nonblock 模式代表写入不会受限于 buffer 的大小，而应该取决于应用内存的大小。为了实现这一点，就要求 buffer 本身的大小取决于应用内存，在这之外根据是否为 nonblock 模式做一些限制。也就是说，我们需要 buffer 是一个可以动态调整大小的列表，那链表就是一个很好的选择：

```go
func (c *channel) Input(v interface{}) {
  // 如果 cw 已经被关闭了，这里就直接返回，而不是崩溃退出
	if c.isClosed() {
		return
	}

	// 将输入包装在 item 结构中，item 用于判断元素是否已经过期
	it := item{value: v}
	if c.timeout > 0 { // 如果 cw 在初始化时声明了元素的最大生存时间，就在 item 中记录元素的过期时间
		it.deadline = time.Now().Add(c.timeout)
	}

	// 仅非 nonblock 模式时才判断是否命中限流
	if !c.nonblock {
		if c.throttling(c.producerThrottle) {
			// closed
			return
		}
	}

	// enqueue buffer
	c.bufferLock.Lock()
	if !c.nonblock {
		// 阻塞模式下如果当前 buffer 的长度已经超过了初始化时声明的最大长度，就将当前协程挂起
		for c.buffer.Len() >= c.size {
			c.bufferCond.Wait()
		}
	}
  // 否则向 buffer 中写入内容，事实上执行到这里时有可能当前的 cw 已经关闭了，
  // 但 enqueueBuffer 并没有做进一步的判断，所以需要保证尽管 cw 被关闭，buffer 仍然是一个可用的结构，
  // 最终 buffer 靠 GC 来做清除
	c.enqueueBuffer(it)
	atomic.AddUint64(&c.produced, 1)
	c.bufferLock.Unlock()
	c.bufferCond.Signal() // 通知其他协程当前 buffer 有变动，消费协程会因此开始消费 buffer
}
```

## 限流

从上面的写入和读取相关代码可以看到，cw 在做具体的处理前都先判断当前是否命中了限流。这个限流是配合初始化时声明的 producerThrottle 和 consumerThrottle 来分别判断的，由于这俩都是函数，所以可以实现各种动态的限流方案，这里不对每种方案做解读，只给出注册限流函数和判断是否该限流的源码解读：

```go
// WithThrottle 用于注册限流函数
func WithThrottle(producerThrottle, consumerThrottle Throttle) Option {
	return func(c *channel) {
    // 如果此前没有设置过 producerThrottle，那么直接赋值
		if c.producerThrottle == nil {
			c.producerThrottle = producerThrottle
		} else {
      // 否则新的 producerThrottle 等于旧的 producerThrottle 且入参的 producerThrottle
			prevChecker := c.producerThrottle
			c.producerThrottle = func(c Channel) bool {
				return prevChecker(c) && producerThrottle(c)
			}
		}
    // consumerThrottle 的处理逻辑相同
		if c.consumerThrottle == nil {
			c.consumerThrottle = consumerThrottle
		} else {
			prevChecker := c.consumerThrottle
			c.consumerThrottle = func(c Channel) bool {
				return prevChecker(c) && consumerThrottle(c)
			}
		}
	}
}

// throttling 用于根据传递的 Throttle 做实际的限流操作
func (c *channel) throttling(throttle Throttle) (closed bool) {
	if throttle == nil { // 如果传递了 nil（初始化时没设置 Throttle 函数），这里直接返回
		return
	}
	throttled := throttle(c)
	if !throttled { // 如果设置了 Throttle 但判断为不需要限流，这里直接返回
		return
	}
  
  // 创建一个 ticker，每隔 throttleWindow 再调一次 Throttle 判断是否仍被限流
	ticker := time.NewTicker(c.throttleWindow)
	defer ticker.Stop()

  // 只要当前 cw 没有被关闭且仍处于被限流状态，就继续循环下去
	closed = c.isClosed()
	for throttled && !closed {
		<-ticker.C
		throttled, closed = throttle(c), c.isClosed()
	}
	return closed
}
```

