---
title: 浅析 dataloader 源码
date: 2023-04-05 08:32:34
categories:
 - [Golang]
description: 分析 6.0.0 版本的 graph-gophers/dataloader 源码
---

> 代码地址：[graph-gophers/dataloader at v6.0.0 (github.com)](https://github.com/graph-gophers/dataloader/tree/v6.0.0)

# 前言

dataloader 是 Facebook 提出的一种获取资源的方式，其最初的目的是为了解决 GraphQL 查询数据时的 N+1 问题，但这种加载数据的方式其实很普适。

宏观上看 dataloader，它主要有批量请求（batch）和缓存这两个机制，批量请求的意思是 dataloader 在加载数据前会“等”一段时间，把一个时间窗口内的所有请求聚合成一个 batch 然后下发。举例来说，假设我们有一个接口可以根据一批 user_id 来获取对应用户的个人信息，那么我们就可以在这个接口前套一层 dataloader，这样当间隔很近的 a、b、c 三个请求分别想获取 user_id 为 1、2、3 的用户信息时，dataloader 会将它们聚合成一个批量请求，通过这个请求拿到数据后再向上将结果分别返回给这三个源请求。在这个过程中，a、b、c 不需要感知 dataloader 的聚合，他们甚至不需要感知彼此的存在。

然而光有 batch 还不够，因为会有入参重复的问题。比如上面假设的场景中，如果 a、b、c 都要获取 user_id 为 1 的用户信息，那么 batch 会将它们聚合为一个入参有三个 1 的请求，而这批参数其实是冗余的。所以，我们需要保存“正在处理中的  id”的处理过程，并可以根据这个过程来拿到最终的处理结果，这里说的有点抽象，其实这和 singleflight 的原理是类似的，最终目的都是要保证同一时间多个同样的 user_id 只会触发一次回源，即 duplicate suppression。

另一方面，缓存的实现可以根据业务场景而有所不同，比如对于一些变更不频繁的资源，缓存不仅可以用于去重，还可以通过延长缓存时间来减少回源，进一步降低下游服务的压力。

为了更好地理解 dataloader 的运行机制，本文尝试分析 graph-gophers/dataloader 6.0.0 版本的源码，在下文中，这个仓库会被简称为 dataloader。

# 源码解读

dataloader 中的核心结构是 [Loader 结构体](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L51-L90)，这个结构体可以通过 [NewBatchedLoader 函数](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L168-L191)来创建，该函数接收一个 batch 函数作为固定入参，这个函数的作用是根据一批 key 来获取对应的一批 Result 结构，具体的获取逻辑由调用方决定；除此之外，这个初始化方法还通过 [functional-options](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L107-L166) 的方式来为 Loader 的一些核心字段赋值。

Loader 结构体实现了 [dataloader.Interface 接口](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L14-L28)，其中逻辑最复杂的是 [Load 方法](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L193)，这个方法用于根据单个 key 获取对应的 [Thunk 结构](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L92-L96)，是我们研究的重心。这里的 Thunk 其实是一个闭包，它封装了获取结果的操作，调用方只需要调用它就可以等着拿入参对应的资源了，并不需要关心 Loader 在这个过程中做了什么。Thunk 其实就是我们前面提到的“正在处理中的 id”的处理过程，具体而言，Loader 针对每一个 Key 做了缓存，缓存的内容就是 Thunk，所以不同请求中同样的 Key 会获取到同一个 Thunk，也即同一个闭包，当然也就根据同一份回源操作拿到了同样的数据。

我们具体来看 Loader.Load 方法，它首先定义了一个 [channel](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L197) 和一个临时结构体 [result](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L198-L201)，前者用于通知 Thunk 函数“计算已经完成”，后者则被 Thunk 用作记录最终的计算结果。我们前面提到，Thunk 函数是 dataloader 在缓存中保存的东西，这个版本的 dataloader 对[缓存接口](https://github.com/graph-gophers/dataloader/blob/v6.0.0/cache.go#L5-L11)的定义中包括 Get/Set/Delete/Clear 四个方法，不包括 GetOrSet 这种原子操作，所以为了保证读写的原子性，Loader 结构中有 [cacheLock](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L61) 字段专门用于对缓存操作加锁。回到代码中，如果 Loader 的缓存中已经存在某个 key 对应的 Thunk 函数，那么直接将该函数返回，否则创建一个新的 Thunk，并以请求的 key 作为索引保存在缓存中，这样一来，同一个 key 的所有请求都会从缓存中获取到同一个 Thunk，从而达成了去重的目的避免冗余的回源。

接下来回到 [Thunk](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L211-L226) 本身，可以看到它是一个捕获了前面定义的 result 结构的闭包，如果 result.value 的值为 nil，那么它就会尝试从前文定义的 channel 中读取结果，并将读到的结果赋值到 result 中。需要注意的是，尽管读取和写入 result 时都加了锁，但当多个 goroutine 请求同一个 key 时，它们中仍可能有多个会走到从 channel 中[读取数据](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L218)部分的逻辑。但这个 channel 被定义为只能容纳一个元素，且它也不可能一直被写入数据，所以如果 channel 的写入方仅仅只是把回源的结果写入后就不管这个 channel，那么这些尝试从 channel 中读取数据的 goroutine 就会永远阻塞在这里。解决这个问题的方法就是向这个 channel 中写入数据后理解对其调用 close，因为读取已关闭的 channel 是不会阻塞的，只是如果使用类似 `v, ok := <-channel` 的语法，那么 ok 会返回 false。回到 Loader 中的逻辑，如果 ok 不为 true，那么 result 并不会被更新。

我个人认为这里的 Thunk 实现的不够高效，因为它的完整流程需要加锁三次。这里之所以有这么多的锁操作，是因为 result 的赋值和读取都被放在 Thunk 中，如果将 result 换成指针并将其传递给负责回源的 goroutine，由它来完成 result 的赋值，并在赋值结束后通过关闭 channel 来通知 Thunk（或者参考 singleflight 使用 WaitGroup 来通知），这样 Thunk 就只需要直接通过闭包从 result 里读取数据，完全不需要依靠加锁来避免竞争了。

到这里为止，Thunk 的部分就结束了，接下来我们来看回源逻辑。

Loader.curBatcher 是一个 [batcher 类型](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L375-L381)，该类型定义了一系列方法用于异步回源。对于 curBatcher，它是[延迟初始化](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L238-L239)的，即当且仅当它被使用时才会进行初始化，所以为了避免并发环境导致 curBatcher 被重复初始化，Loader 定义了 [batchLock 字段](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L76-L77)专门对 batcher 的操作进行加锁。之所以如此大费周章也要做成延迟初始化的形式，是因为每个 batcher 结构只能被使用一次，它会负责聚合一段时间内的请求并调用使用方传给 Loader 的回源函数做具体的回源，这波回源完，下一波请求就需要新的 batcher 来负责了。

在实现上，batcher 的 [input](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L376) 被定义为一个 [batchRequest](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L101-L105) 的 channel，这个 channel 的容量由 [Loader.inputCap](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L70-L71) 决定，该字段的值可以通过调用 NewBatchedLoader 函数时传递 [WithInputCapacity](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L124-L129) 来修改，[默认为 1000](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L172)，这个字段可以理解为并发度，即同一时间最多有 1000 个 key 可以被写入。当 Loader.Load 方法被调用时，key 和 result 的 channel 会组合成 batchRequest 结构通过 batcher.input 传递给 Loader.curBatcher，input 这个 channel 在 batcher.batch 方法中被读取，这个方法在调用时通过另一个 goroutine 来承载，所以它不会阻塞调用 Loader.Load 的 goroutine。batcher.batch 通过 [for-range  不停地读取 batcher.input](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L411-L414)，这个操作在 input 被 close 之前会一直阻塞在这里，而它后面的逻辑就是正常的回源操作。所以不难想象，当满足某个条件时，这个 channel 一定会被 close，从而触发回源并将结果写回 batchRequest 的 channel 来通知 Thunk。

继续阅读源码，我们会发现 [batcher.end 方法](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L394-L400)对 batcher.input 调用了 close，它本身没有加锁，所以它的调用方一定加过锁，否则会因为重复关闭 channel 而导致 panic。这样一来，batcher.end 就可以被认为是回源操作的触发器，它被两个地方调用，分别是 [Loader.sleeper](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L469-L492) 和 [Loader.Load](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L256)。我们首先来看前者，它的作用是“等一段时间”后调用 batcher.end，这其实就是常规的 dataloader 加载数据的方式，它等待的时间由 [Loader.wait 字段](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L73-L74)决定，这个字段可以在调用 NewBatchedLoader 函数时通过 [WithWait](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L131-L137) 来修改，[默认是 16 毫秒](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L173)。然而，单纯的通过时间来触发回源是有风险的，因为短短的 16 毫秒就可能让 batcher.input 中积累大量的 key，这些 key 会一起传递给回源函数，从而给下游造成压力，因此我们需要有一种机制来控制每次回源的 key 的数量，并在 batcher 积累了足够的数量后提前回源，从而不影响后续的 key 进入**新的 batcher**，而这就是 batcher.end 的另一种使用方式，它被定义在 Loader.Load 中。

具体而言，在调用 NewBatchedLoader 函数时可以通过传递 [WithBatchCapacity](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L117-L122) 来修改 Loader.batchCap，即单次回源可以接受的最大 key 数量，和 Loader.inputCap 不同，这个值默认值为 0，表示不作限制。当它大于 0 时，Loader 会在 Loader.count 中记录当前已经传递给 batcher 的 key 数量，当 Loader.count 达到 Loader.batchCap 时立即调用 batcher.end 方法来触发回源，并通过 Loader.reset 来将 batcher 赋值为 nil，这样当新的 key 到来时，新的 batcher 就会被创建。由于 batcher.end 是幂等的，所以即便放任 Loader.sleeper 正常执行也没有关系，但如果 Loader.wait 的值很大，那么可能会导致 goroutine 数量持续增高，因此当 Loader 因为达到 batchCap 而提前回源时，终止 Loader.sleeper 的执行是必要的，这通过一个监听了两个 channel 的 [select](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L471-L477) 来实现。

完整看下来，可以发现 Loader.Load 对 key 的去重完全依赖缓存，而 dataloader 使用的缓存是可以修改的（通过 [WithCache](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L110-L115) 实现），所以根据缓存的容量、逐出策略的不同，很可能重复的 key 在缓存中却读不到对应的 Thunk（更极端的，dataloader 还提供了 [NoCache](https://github.com/graph-gophers/dataloader/blob/v6.0.0/cache.go#L13-L28) 来适应一些特殊场景），此时 batcher 中就会有重复的 key，因此传递给回源函数的 key 列表中也会有重复的元素。在 dataloader 中，回源函数被定义为 [BatchFunc 类型](https://github.com/graph-gophers/dataloader/blob/v6.0.0/dataloader.go#L30-L34)，它的注释中提到 dataloader 会保证传给它的 key 列表中没有重复元素，这个说法是不严谨的，因此如果你使用了这个库，那么在编写 BatchFunc 时可能需要注意这一点，必要时需要手动进行去重。

到此为止，我们就分析完了 Loader.Load 这个核心方法，dataloader.Interface 的其他方法相对比较简单，这里就不进行分析了，有兴趣的朋友可以继续阅读相关的部分，也欢迎一起交流。
