---
title: bytedance/gopkg 中 gopool 的源码解读
date: 2023-04-16 01:20:49
categories:
 - [Golang]
description: 趁热打铁，读完连接池读协程池
---

# 前言

前几天从连接池的角度阅读了标准库中 database/sql 的源码，并写了对应的[博客](/2023/04/12/SqlConnectionPool/)做总结。最近逛 github 时看到字节开源的 gopkg 代码库中有一个叫 [gopool](https://github.com/bytedance/gopkg/tree/develop/util/gopool) 的协程池实现，代码只有 200 多行，感觉还蛮有意思的，于是就有了现在的这篇文章。

# 功能简述

根据 readme 来看，gopool 的目标是作为 go 关键字的一个可选方案，具体来说，它对外暴露了 gopool.Go 这个函数，内部接收一个函数作为入参，这个函数不接受任何参数也不返回任何内容，但因为 golang 本身有闭包的特性，所以这并不影响使用。

我个人非常喜欢 gopool 对外暴露的接口，因为它与 golang 本身的相似性使得使用起来时几乎没有什么心智负担。还是以 gopool.Go 函数为例，同 go 关键字相同，这个作为入参的函数是异步执行的，而且调用方也不会因为这个函数调用而阻塞。为了达成这个效果，gopool 不能真的起一个 goroutine，取而代之的，它用了类似 js 的任务队列的方式，因为它本身是做协程池的，如果每调一次 gopool.Go 就创建一个新协程，那这个函数就没意义了。

最后，gopool 处理了协程内部的 panic。这点很重要，因为如果你使用了某个框架来开发应用，那么你的主流程的 panic 很可能可以被这个框架捕获并优雅处理，从而保证应用整体不会因为这个 panic 而崩溃，但如果你在主流程中启动了新的协程，这个协程的 panic 就需要由你自己来保证了，而这项工作通常是重复且枯燥的，gopool.Go 在这点上提供了一种侵入性很低的解决方案。

# 源码解读

接下来把视角回到代码本身，上面介绍的 [gopool.Go](https://github.com/bytedance/gopkg/blob/develop/util/gopool/gopool.go#L36-L43) 函数其实是对全局 [defaultPool](https://github.com/bytedance/gopkg/blob/develop/util/gopool/gopool.go#L23-L24) 变量的 CtxGo 方法的调用（golang 标准库中有很多函数也是类似的实现方式，比如 net/http 的 client 和 handler），所以如果要了解原理，就需要看 defaultPool 本身是什么。

从定义上看，defaultPool 是一个 [Pool](https://github.com/bytedance/gopkg/blob/develop/util/gopool/pool.go#L23-L36) 接口的实例，由 [NewPool](https://github.com/bytedance/gopkg/blob/develop/util/gopool/pool.go#L93-L101) 函数初始化，这个函数的功能很简单，它根据入参构造了一个 [pool](https://github.com/bytedance/gopkg/blob/develop/util/gopool/pool.go#L72-L91) 结构，然后将这个结构返回。pool 结构是 Pool 接口的一个实现，它的定义是下面这样的：

```go
type pool struct {
	// 协程池的名字，有 Name 方法可以返回
	name string

	// 这个协程池同时最多允许多少 worker 存在
	cap int32
  
	// 配置信息，目前只有一个阈值的属性，具体见下文
	config *Config
  
	// task 队列的元信息，每一个 task 代表一个待执行的函数
	taskHead  *task
	taskTail  *task
	taskLock  sync.Mutex
	taskCount int32

	// 当前有多少个 worker 在运行中，每个 worker 代表一个 goroutine
	workerCount int32

	// 由这个协程池中的协程引发的 panic 会由该函数处理
	panicHandler func(context.Context, interface{})
}
```

所以从这个定义我们能知道，如果把 pool 看作是一个可操作单元，那么它内部维护了一个 task 的队列（通过链表来实现），其中的每个 task 结构代表一个待执行的函数，除此之外，它还对应多个 worker，这些 worker 从 task 中获取函数并执行。总结来说，pool.CtxGo 方法是 task 的生产者，worker 则是 task 的消费者，两者的交互通过 task 链表来完成。

下面我们直接来看 pool.CtxGo 这个方法，它也是协程池的核心方法，它的定义是这样的：

```go
func (p *pool) CtxGo(ctx context.Context, f func()) {
  // 从 taskPool 中取一个 task 结构体，通过复用结构体来减少 gc 压力
	t := taskPool.Get().(*task)
  
  // 使用入参来初始化 task 结构
	t.ctx = ctx
	t.f = f
  
  // 通过加锁将 task 并发安全地放在队列的尾部，并更新队列长度
	p.taskLock.Lock()
	if p.taskHead == nil {
		p.taskHead = t
		p.taskTail = t
	} else {
		p.taskTail.next = t
		p.taskTail = t
	}
	p.taskLock.Unlock()
	atomic.AddInt32(&p.taskCount, 1)
  
	// 满足条件时，从 workerPool 中取一个 worker 结构并在初始化后调用其 run 方法
	if (atomic.LoadInt32(&p.taskCount) >= p.config.ScaleThreshold && p.WorkerCount() < atomic.LoadInt32(&p.cap)) || p.WorkerCount() == 0 {
		p.incWorkerCount()
		w := workerPool.Get().(*worker)
		w.pool = p
		w.run()
	}
}
```

在 gopool 中，task 和 worker 都通过 sync.Pool 来实现复用。当拿到一个可用的 task 结构后，pool.CtxGo 会将它放入 task 队列的尾部，然后判断一些条件，如果满足就获取一个可用的 worker 并调用其 run 方法，否则直接退出函数。所以整个过程中与入参的 f（也就是用户希望通过 goroutine 执行的函数）的关系其实只在于将它加入到链表中，f 在 pool.CtxGo 中并没有被执行到。

worker 是真正干活的部分，它在 worker.pool 字段中保存了自己当前负责处理的 pool 结构，所以它也能间接访问到这个 pool 中的 task 链表。而它的核心方法是 [worker.run](https://github.com/bytedance/gopkg/blob/develop/util/gopool/worker.go#L40-L74)。可以发现，这个方法整体就是一个普通的 goroutine，内部有一个 for 循环，循环内首先尝试从 pool 的 task 链表中获取一个任务，如果拿到的是 nil，那么说明当前 pool 内没有要执行的 task，此时会做一些收尾工作并结束整个 goroutine 的运行。而如果获取到了 task，那么它会调用其内部的 f，这个 f 对应用户传入的某个待运行的函数。执行完毕后，这个 task 会被回收到 taskPool 中供未来复用。

如果某个 task 执行时发生 panic，这个 panic 会被捕获，此时如果用户通过 [pool.SetPanicHandler](https://github.com/bytedance/gopkg/blob/develop/util/gopool/pool.go#L141-L144) 设置了 pool.panicHandler，那么 recover 返回的内容会被传递给这个函数，方便用户自己做一些自定义的操作。

这里需要注意的是，为了实现 panic 的捕获，worker.run 在 for 循环内部起了一个[立即执行表达式](https://github.com/bytedance/gopkg/blob/develop/util/gopool/worker.go#L58-L70)，并在内部通过 defer 来做 panic 的 recover。这是必要的，因为只有这样它才能把 panic 的影响限制在单个 task 上。否则如果放在 worker.run 的一开始，那么当某个 task panic 时整个 worker.run 函数就会结束，其他的 task 就没办法被继续执行了；而如果放在内部的 goroutine 中，worker.run 就需要在 goroutine 异常退出时创建一个新的 goroutine，这就需要引入更多的 goroutine 来做监控，因为 worker.run 本身的执行是一定不能阻塞的，否则对外暴露的 gopool.Go 就会阻塞，这就与 go 关键字的行为不一致了。

到此为止，我们就基本梳理完了协程池中 task 的创建与消费，但如果你回头看 pool 的定义，会发现它 cap 和 config 的字段没有提到，因为 pool.CtxGo 中 [if](https://github.com/bytedance/gopkg/blob/develop/util/gopool/pool.go#L133) 的条件我们也还没有分析。先说结论，一个 worker 就有能力消费掉 pool 中的所有 task，虽然这个消费的过程与主流程是异步的，但它自己内部其实是串行的，这意味着如果执行某个 task 需要花很长的时间，那么后面的 task 都要等这个 task 执行完才能继续被执行，所以为了解决这个问题，我们就需要有多个 worker 来一起并发消费 pool 中的 task。但通过前面的分析我们知道，一个 worker 对应一个 goroutine，而 gopool 是做协程池的，所以它必须要能够限制 goroutine 的数量。

所以总结来说，我们既需要在 task 数量达到某个值时创建新的 worker 来避免所有的 task 串行执行，又需要限制 worker 的数量不能超过某个值。这个需求就是通过前面被我们跳过的 if 来实现的，具体来说，pool.config.ScaleThreshold 定义了一个下限，当 task 的数量大于等于这个值时，新的 worker 可能会被创建，而 pool.cap 定义了一个上限，它要求 worker 的总数不能超过这个值，这两个条件同时配合起来，就能够满足我们的要求了。

