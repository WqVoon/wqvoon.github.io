---
title: golang x/sync 包源码解读
date: 2022-12-12 19:55:52
categories:
 - [Golang]
description: 包括 errgroup、singleflight、syncmap、semaphore
---

# 前言

golang 的 sync 和 sync/atomic 标准库中提供了很多并发编程相关的基础工具，基于这些基础工具可以向上封装一些更适用于应用场景的工具。比如 [x/sync](https://github.com/golang/sync) 包就提供了 errgroup、singleflight、syncmap 和 semaphore，其中 syncmap 在 go1.9 版本中已经进入了 sync 标准库中，被广泛应用在各种应用中。除此之外，我在工作中也使用过其中的 errgroup 和 singleflight。

为了更好地理解其中的原理，下面对这四种工具的源码进行解读，这篇博客假设读者已经掌握了这些工具的使用方法，如果有需要，读者可以通过点击上面的链接来查看各个工具的测试代码。

# errgroup

> 源码：https://github.com/golang/sync/blob/master/errgroup/errgroup.go

errgroup 整体而言比较简单，可以看作是 sync.WaitGroup 的升级版，所以能使用 sync.WaitGroup 的场景基本都可以用 errgroup 来代替。为了方便表述，后文将 sync.WaitGroup 均称为 wg，这也是我通常使用的该类型变量的变量名。

wg 适用于一个 goroutine 等待多个 goroutine 执行的场景，举例来说，我们作为服务端可能要给前端返回用户的详细个人信息，这些信息需要调用不同的 rpc 从不同的服务中获取，最终由请求的 handler 整合后返回。那么就可以提前生成一个响应结构，然后通过 wg 来启动多个 goroutine，每个 goroutine 负责请求不同的 rpc 并将结果填充进响应结构中，对于生成响应的 goroutine 而言只需要 `wg.Wait()`，当这个函数返回时就代表所有的子 goroutine 都结束执行了。

上面这个场景用代码表示的话，大概是这个样子：

```go
	wg := new(sync.WaitGroup)

	wg.Add(1)
	go func() {
		defer func() {
			goRecover()
			wg.Done()
		}()
		// do something
	}()

	wg.Add(1)
	go func() {
		defer func() {
			goRecover()
			wg.Done()
		}()
		// do something
	}()

	// ...

	wg.Wait()
```

上面的代码有什么问题呢？首先，每个子 goroutine 都有一个 `wg.Add(1)` 和 `wg.Done()`，尽管可以只做一次 `wg.Add(n)`，但使用者需要正确地维护 `wg.Add` 和 `wg.Done` 的对应关系，如果 `wg.Add` 大于 `wg.Done`，那么 `wg.Wait` 就会卡死，反过来则会导致 panic；另一方面，子 goroutine 内部有可能会产生错误，但原生 wg 并不感知各个子 goroutine 是否正常结束，它甚至不感知子 goroutine 的存在；除此之外，除了 `wg.Wait`，各个 goroutine 并没有什么联系，原生 wg 并不能做到类似 “某个 goroutine 发生错误时就终止其他 goroutine” 的功能。

而这些在 errgroup 下都可以得到解决。errgroup 提供了一个名为 Group 的结构，该结构的定义是这样的：

```go
// A Group is a collection of goroutines working on subtasks that are part of
// the same overall task.
//
// A zero Group is valid, has no limit on the number of active goroutines,
// and does not cancel on error.
type Group struct {
	cancel func()

	wg sync.WaitGroup

	sem chan token

	errOnce sync.Once
	err     error
}
```

可以看到在这个结构体中除 cancel 和 sem 外所有的字段都不是指针，而从我们后面的描述中就可以看到， 这两个字段并不是一定要有值才行。所以就像这个结构的注释一样，我们完全可以使用一个零值的 Group，因为此时强依赖的字段都已经是可使用的状态了。

和 wg 不同，Group 是感知子 goroutine 的存在的，它提供了 Go 和 TryGo 方法来做这件事。我们先看 [Go 方法](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L66-L84) ，此时先认为 cancel 和 sem 都为 nil，那么 Go 方法的定义就变得非常简单，它仅仅包装了 `wg.Add(1)`  和 `wg.Done()` 的过程，使用者此时便不再需要手动维护这两者的关系，只需要关注 `func() error` 内部的逻辑即可。而一旦这个作为入参的函数返回了错误，即 err 不为 nil，那么 Group 就会将这个返回的 err 赋值给内部的 err 字段。由于在赋值时使用了 errOnce，所以最终 Group.err 如果不为 nil，那么它就会是所有子 goroutine 中发生的第一个错误。

但 Group.err 的首字母是小写的，所以我们并没有办法直接访问这个变量，而是要用 [Group.Wait](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L52-L58) 方法。该方法是 wg.Wait 的封装，在此基础上将 Group.err 返回，所以使用者就可以借此访问到子 goroutine 中的错误了。

到此为止，零值的 Group 已经解决了我们前面说的三个问题中的两个，那么最后一个问题要通过什么来解决呢？我们可以维护一个 channel，所有的子 goroutine 都在 select 中尝试从这个 channel 中读取或做实际的业务逻辑，一旦有某个 goroutine 遇到错误，就 close 这个 channel，那么其他的 goroutine 都会从这个 channel 中读取到内容，从而结束后序逻辑。

但是 Group 不是这样做的，它采用了 golang 中一个更接近应用场景的思维模式的工具，也就是 context。

我们前面讨论 Group 的基本功能时，是假设 cancel 和 sem 都是 nil 的。但如果 [cancel 不为 nil](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L78-L80)，那么就可以做到当一个 goroutine 出错时，其他 goroutine 都提前返回的功能。Group 提供了 [WithContext 方法](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L45-L48) ，该方法调用 `context.WithCancel` 来包装外部传递的 ctx，并返回新的 ctx，这样这个新的 ctx 就可以以闭包的方式被 Group.Go 的入参函数所使用。

除了这些功能外，errgroup 还提供了限制并发数量的功能，该功能通过 [SetLimit 方法](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L123-L132) 来实现。该方法接收一个整型数字作为最大并发度，该数字如果大于零，那么会作为 sem 这个 channel 的长度。Group.sem 的类型是 `chan token`，而 token 的定义是 `type token struct{}`。之所以要用 `struct{}`，是因为实际 Group 并不关注 sem 中保存的是什么，它只需要使用 sem 作为 channel 天然所拥有的阻塞能力，所以设置成 `struct{}` 就可以节省空间，因为该类型本身并不占用内存。errgroup 的限流采用了漏桶算法的思想，具体而言，如果 sem 不为 nil，那么 `Group.Go` 在执行前会尝试向 sem 写入一个 token，如果此时 sem 中保存的 token 已经达到了 `Group.SetLimit` 所设置的长度，那么新的写入会被阻塞直到 sem 内的某个 token 被释放。而 token 正是在 [Group.done 方法](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L33-L38) 中被释放的，该方法在 `Group.Go` 的入参函数执行完成时就会被调用。

最后，Group 还提供了 [TryGo 方法](https://github.com/golang/sync/blob/master/errgroup/errgroup.go#L90-L114) 来让使用方感知是否被限流。该方法和 Group.Go 方法的区别在于向 sem 中写入 token 的部分，通过 select-default 的方式来“浅尝辄止”：如果 `g.sem <- token{}` 的部分不能成功，那么 select 会走到 default 的部分，并在这部分返回 false 表示因为被限流导致没能成功启动子 goroutine。

# singleflight

> 源码：https://github.com/golang/sync/blob/master/singleflight/singleflight.go

singleflight 提供了一种名为 “duplicate suppression” 的能力，这种能力非常适合用来处理缓存回源问题。举例来说，假设我们在应用中维护了一份 localcache，当用户通过发起请求来根据某个 key 获取对应的值时，应用首先在 localcache 中寻找，如果没有找到则回源到存储层中去寻找，并将找到的值或空值写回 localcache 以在下一次请求时避免回源。

在这个场景下，回源这个节点就成为了关键节点，因为当应用具备一定的并发量时，很有可能在同一时间会有多个针对同一个 key 的请求，而它们在读取 localcache 时均会发现其中没有自己需要的数据，从而进行回源，这时这些请求都会被漏放到存储层，从而使其瞬时压力升高，极端情况下可能会导致存储不可用。但实际上，这些发生在同一时间的回源请求读取存储时拿到的结果都是相同的，所以我们完全没必要将所有的请求都放到存储层。

这些不必要的回源请求，其实就是 duplicate 的，而 singleflight 要做的就是把这些不必要的请求拦截，只允许其中一个请求发生，其他请求直接读取这个请求返还的结果。

在 singleflight 包中，核心结构有如下三个：

```go
// call is an in-flight or completed singleflight.Do call
type call struct {
	wg sync.WaitGroup

	// These fields are written once before the WaitGroup is done
	// and are only read after the WaitGroup is done.
	val interface{}
	err error

	// These fields are read and written with the singleflight
	// mutex held before the WaitGroup is done, and are read but
	// not written after the WaitGroup is done.
	dups  int
	chans []chan<- Result
}

// Group represents a class of work and forms a namespace in
// which units of work can be executed with duplicate suppression.
type Group struct {
	mu sync.Mutex       // protects m
	m  map[string]*call // lazily initialized
}

// Result holds the results of Do, so they can be passed
// on a channel.
type Result struct {
	Val    interface{}
	Err    error
	Shared bool
}
```

而这三个中，Group 又占主导位置，singleflight 提供的功能函数都要通过这个结构来调用。从代码中的注释可以看出，Group.m 是延迟初始化的，而 Group.mu 是一个值类型，所以和 errgroup.Group 相同，这个 Group 同样可以直接使用零值来完成一系列的功能。

首先，最核心的方法便是 [Group.Do 方法](https://github.com/golang/sync/blob/master/singleflight/singleflight.go#L82-L106)，这个方法的一开始就通过 Group.mu 进行了加锁处理，而解锁部分有两处，分别对应两类 goroutine 进入这个方法的路径。区分这两类路径的核心在于 `if c, ok := g.m[key]; ok {` 这里，因为加了锁，所以这里不存在并发读的问题。如果这个 key 是第一次被使用，那么此时 g.m 中是不存在这个 key 的，所以此时会生成一个 call 结构并将其添加到 g.m 中，然后将 c.wg 通过 Add 增加 1 后调用 g.doCall 来尝试根据入参的 `fn func() (interface{}, error)` 获取结果。另一方面，如果这个 key 后续被其他 goroutine 使用时，前面提到的 if 就可以根据这个 key 从 g.m 中取出对应的 call，以从中直接获取结果。

我们先简单地将 doCall 理解为获取结果的方式，那么整个 singleflight 过程中有两点比较重要，首先是其他 goroutine 怎样才能知道这个 call 中的结果已经准备好了；另一方面，如果准备好了，负责 g.doCall 的 goroutine 是怎么把结果送给其他 goroutine 的。

从 Group 的定义中可以发现，Group.m 是一个 string 到 \*call（指针） 的 map，这意味着不论哪个 goroutine 根据 key 从 Group.m 中拿到 call 结构都是同一个，所以任意一个 goroutine 对它的修改都能被其他 goroutine 所感知，这就解决了结果传递的问题，因为只要负责 g.doCall 的 goroutine 将结果写入 call.val 和 call.err，其他 goroutine 就可以从同一个 call 中读取这两个字段的结果。而前文所述的第一个问题也有很多解法（比如我们前面提到过的 close(channel) 的方法），不过在 singleflight 这个包中，是通过 WaitGroup 来实现的。具体而言，负责 g.doCall 的 goroutine 会对 call.wg 结构执行 Add 方法，而其他 goroutine 则对 call.wg 结构执行 Wait 方法。这样一旦 call.wg 的 Done 方法被调用，那么所有的 call.wg.Wait 都会返回，而由于 Done 是在 [doCall 结束时](https://github.com/golang/sync/blob/master/singleflight/singleflight.go#L149) 被调用的，所以此时其他 goroutine 就已经可以从 call.val 和 call.err 中拿到 doCall 的结果了。

同时，为了让使用者感知到是否有多个 goroutine 使用了同一个 call 结构，singleflight 在 call 中还维护了 dups 字段，该字段在 Group.Do 流程进入前文所述的 if 中时[会被加一](https://github.com/golang/sync/blob/master/singleflight/singleflight.go#L88)，所以只要在 Group.Do 返回时判断下 call.dups 是否大于 0 即可得知。

我个人认为 singleflight 对 WaitGroup 的应用还蛮有趣的，通常而言我对它的定位都是多个 goroutine 做 wg.Add 和 wg.Done，一个 goroutine 做 wg.Wait，而这里则是反过来的，通过多个 Wait 来实现多个 goroutine 等待一个 goroutine 的效果，这也说明了 wg.Wait 是幂等的。

和 Group.Do 方法类似，[Group.DoChan 方法](https://github.com/golang/sync/blob/master/singleflight/singleflight.go#L112-L132) 也提供了 singleflight 的能力，只不过执行的结果是以 `<- chan Result` 的方式返回的，从 Result 结构的定义可以看到，这个结构描述的其实就是 Group.Do 的返回值。所以 Group.DoChan 和 Group.Do 在原理上是基本相同的，唯一的区别在于结果的处理上，为了实现异步返回，Group.doCall 是以 goroutine 的方式来调用的，而每个请求 Group.DoChan 的 goroutine 都对应一个 `<- chan Result` 结构，被保存在 call.chans 中，Group.doCall 会在获取到结果后依次将结果填充进 call.chans 中的每个元素中。这样 Group.DoChan 并不需要依赖 call.wg 来做 goroutine 间的结果同步，因为当 Group.doCall 结束时每个 goroutine 对应的 chan 中都能直接获取到结果。

所以由于 Group.m 这个 map 的存在，所有使用同样 key 的 goroutine 都可以从相同的 call 结构中获取到同一份结果。但是如果某个 key 一直存在于 Group.m 中，后续的所有针对这个 key 的 goroutine 都会不经过入参的 fn 的计算而直接从 call 中拿到旧的结果，这显然是不符合预期的，所以 key 一定是要被清理的。在 singleflight 中，[Group.doCall 方法](https://github.com/golang/sync/blob/master/singleflight/singleflight.go#L150-L152) 会自动做 key 的清理，可以看到这里先判断了 `Group.m[key]` 是否是预期删除的 call，之所以这里要这样做，是因为 singleflight 还提供了 Group.Forget 方法来让使用者主动删除 Group.m 中的某个 key，而一旦这个方法被调用，紧随其后的第一个请求同一个 key 的 goroutine 就会向 Group.m 中填充新的 call 并再次调用 Group.doCall，此时 `Group.m[key]` 对于上一个调用 Group.doCall 的 goroutine 来说就是不该删除的了，因为现在的 call 与它毫无关系。

那么 Group.m 中某个 key 对应的 call 结构发生变化，是否会影响使用前一个 call 的那些 goroutine 们呢？答案是不会，因为它们在自己的函数栈中都创建了 c 变量，也就是上一个 call 的指针，就算其他的 goroutine 修改了 Group.m，这个 c 变量还是指向原来的 call 结构。我个人认为 singleflight 对 Group.m 的运用是非常有趣的，它在保存了旧 call 引用的同时还决定了当前的 goroutine 是否需要做 Group.doCall，非常棒。

除了删除 Group.m 中的 key，Group.doCall 主要做的就是调用入参的 fn，然后把结果填充进 call 中的 val、err、chans，这些在前面我们都已经讨论过了。除此之外，Group.doCall 还区分了 fn 内部是否发生了 panic 或 `runtime.Goexit`，这里做得也很巧妙，是用两个 defer 来做的，函数 [最下面的代码](https://github.com/golang/sync/blob/master/singleflight/singleflight.go#L193-L195) 在 `runtime.Goexit` 时不会被执行，但 panic 却会执行，利用这一点就区分出了两种情况。

# syncmap

> 源码：https://github.com/golang/sync/blob/master/syncmap/pre_go19.go

如前所述，syncmap 在 go1.9 时已经进入了标准库，所以我认为应该大多数的 gopher 都使用过这个工具。在 syncmap 中，核心的结构体有如下三个：

```go
// Map is a concurrent map with amortized-constant-time loads, stores, and deletes.
// It is safe for multiple goroutines to call a Map's methods concurrently.
//
// The zero Map is valid and empty.
//
// A Map must not be copied after first use.
type Map struct {
	mu sync.Mutex

	// read contains the portion of the map's contents that are safe for
	// concurrent access (with or without mu held).
	//
	// The read field itself is always safe to load, but must only be stored with
	// mu held.
	//
	// Entries stored in read may be updated concurrently without mu, but updating
	// a previously-expunged entry requires that the entry be copied to the dirty
	// map and unexpunged with mu held.
	read atomic.Value // readOnly

	// dirty contains the portion of the map's contents that require mu to be
	// held. To ensure that the dirty map can be promoted to the read map quickly,
	// it also includes all of the non-expunged entries in the read map.
	//
	// Expunged entries are not stored in the dirty map. An expunged entry in the
	// clean map must be unexpunged and added to the dirty map before a new value
	// can be stored to it.
	//
	// If the dirty map is nil, the next write to the map will initialize it by
	// making a shallow copy of the clean map, omitting stale entries.
	dirty map[interface{}]*entry

	// misses counts the number of loads since the read map was last updated that
	// needed to lock mu to determine whether the key was present.
	//
	// Once enough misses have occurred to cover the cost of copying the dirty
	// map, the dirty map will be promoted to the read map (in the unamended
	// state) and the next store to the map will make a new dirty copy.
	misses int
}

// readOnly is an immutable struct stored atomically in the Map.read field.
type readOnly struct {
	m       map[interface{}]*entry
	amended bool // true if the dirty map contains some key not in m.
}

// An entry is a slot in the map corresponding to a particular key.
type entry struct {
	// p points to the interface{} value stored for the entry.
	//
	// If p == nil, the entry has been deleted and m.dirty == nil.
	//
	// If p == expunged, the entry has been deleted, m.dirty != nil, and the entry
	// is missing from m.dirty.
	//
	// Otherwise, the entry is valid and recorded in m.read.m[key] and, if m.dirty
	// != nil, in m.dirty[key].
	//
	// An entry can be deleted by atomic replacement with nil: when m.dirty is
	// next created, it will atomically replace nil with expunged and leave
	// m.dirty[key] unset.
	//
	// An entry's associated value can be updated by atomic replacement, provided
	// p != expunged. If p == expunged, an entry's associated value can be updated
	// only after first setting m.dirty[key] = e so that lookups using the dirty
	// map find the entry.
	p unsafe.Pointer // *interface{}
}
```

其中最核心的就是 Map 这个结构，可以看到出了 Map.dirty 外其他的字段均是值类型，所以这个结构的零值也是可以直接被使用的。在 Map 中有 read 和 dirty 两个字段，其中 read 以 atomic.Value 的方式保存 readOnly 这个结构，可以看到 readOnly 中的 m 与 dirty 一样都是 `map[interface{}]*entry` 类型，而这里就是最终保存 k-v 映射关系的地方。

为什么要保存两份呢？很大程度上是为了效率，如果使用得当的话，大多数的读写请求都不需要依赖 Map.mu 这个锁来完成。具体来说，readOnly.m 的读写是通过 atomic 标准库提供的 Load/Store/CompareAndSwap 来做的，虽然我没有深入研究过这些操作的实现，但由于 sync.Mutex 和 sync.RWMutex 是通过 atomic 标准库来实现的，所以 atomic 一定是比 sync 标准库中的锁要高效的。

我个人觉得 readOnly 这个名字起得不好，因为它实际上是有写操作的，但 readOnly.m 仅仅是一个普通的 map，在并发读写时如果不加锁，golang 应该会检测到并报错退出才对。事实上，对于一个新的 key 而言，readOnly.m 并不存在类似 `readOnly.m[key] = val` 这样直接写入的操作，只会 [对已经存在的 key 做更新操作](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L133-L135)，而这种操作并不会命中 golang map 的并发检测。对于那些新的 key，[写入操作都只会发生在 dirty 中](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L155)，所以在读取时如果 readOnly.m 中没有找到，就需要 [到 dirty 中去尝试寻找](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L108)。但是如果 readOnly.m 中没有需要的 key，也不是一定要去 dirty 中读取，这是通过 readOnly.amended 来实现的，当且仅当 [dirty 中拥有 readOnly.m 中不存在的 key 时，这个字段才为 true](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L153)。

通过阅读操作 dirty 的代码就会发现，它真的就只是一个普通的 map，而且存在向其中新增 key 的情况，这就不可避免地要在读写时进行加锁（也就是 Map.mu），而相较于使用 atomic 的 readOnly.m，这就变得非常低效了。所以 dirty 会在一定情况下升级为 readOnly.m，这是通过 [Map.misssLocked 函数](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L338-L346) 来做的，在这个函数中会先增加 Map.misses 字段的值（函数被调用前加了锁，所以不会有并发增加的现象），当该字段的值大于等于 dirty 的长度时，就会执行升级操作。而这个函数只会在读取 dirty 时才会被调用，这样整体看来，就是每次读操作从 readOnly.m 穿透到 dirty 时就会算做一次 miss，而 miss 的次数大于等于 dirty 的长度时，就会将 dirty 升级为 readOnly，升级后的读操作相较于之前就会有所好转，因为新的 readOnly 拥有比之前更多的数据。

回到 readOnly.m 上，这个结构会经历的操作就只有读、更新以及替换整个 map，但是 Map.missLocked 函数在做完 readOnly 的升级后就 [将 dirty 设置为 nil](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L344)，那么当使用者继续向 dirty 中添加新的 key 时，dirty 中不就只有这些新添加的 key 了吗？如果读取这些新的 key 使 miss 达到阈值后发生升级，那么 readOnly 中原来的 key 不就消失了？事实上，当使用者 [向值为 nil 的 dirty 中添加新的 key 时](https://github.com/golang/sync/blob/master/syncmap/pre_go19.go#L149-L154)（也就是 readOnly.amended 为 false），会调用 [Map.dirtyLocked 函数](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L348-L360)。可以发现，这个函数从 readOnly 中复制了所有值不为 nil 和 expunged 的 k-v（这里先不管这两种值的含义，后面讨论删除时会提到），所以此时 dirty 既包含 readOnly.m 中 “有效” 的 k-v，也包含新的 k-v，这样在升级时就不会丢失曾经的 key 了。同时，而由于 readOnly.m 和 dirty 中的值都是指针，所以实际上它们是共享同一份内存的，这一方面减小了空间开销，一方面又保证了一处的修改在另一处也能感知。

我们再来看看删除操作，也就是 [Map.Delete 函数](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L265-L281)。这个函数的思路比较简单，如果 readOnly.m 中没有要删除的 key 而 readOnly.amended 为 true，那么 dirty 中就 “可能” 有要删除的 key，但是具体有没有，syncmap 并不关心，它直接就对 dirty 使用了 `delete(m.dirty, key)`，但这没有什么问题，因为用 delete 尝试从 map 中删除一个不存在 key 并不会报错。而如果 readOnly.m 中存在要被删除的 key，那么就会将其标记为 nil，这个 nil 在 dirty 被初始化时会在 readOnly.m 中 [被替换成 expunged](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L365)，而且不会出现在被初始化的 dirty 中。所以正如 [注释](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L71-L77) 中所描述的，nil 和 expunged 都表示某个 key 被删除，如果 readOnly.m 中被删除的 key 表示为 nil，那么说明此时 dirty 为 nil，如果被删除的 key 表示为 expunged，那么 dirty 就不为 nil（不过如果硬要说的话，其实 [这里](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L140-L145) 在e.unexpungeLocked 结束后 e.storeLocked 执行前对应的 key 就是 nil，此时 dirty 也不为 nil，不过只是一瞬间 :-P）。

所以对于删除这个操作而言，如果被删除的 key 在 readOnly.m 中可以被找到，那么这个删除其实是惰性的，它仅仅只是将 key 对应的值设置为 nil，直到 dirty 发生升级时，readOnly.m 整个被不存在这个 key 的 dirty 替换掉，这个删除才真正发生。在此之前，key 实际是存在于 readOnly.m 中的，只是读取时会 [忽略那些值为 nil 或 expunged 的 key](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L124-L126)，营造出这个 key 不存在的假象。这在多数情况下不会有什么问题，但如果 key 是很占内存的类型，那这个删除也许并不符合应用的预期。

除了读写和删除外，syncmap 还支持 LoadOrStore、Range 等操作，原理和前面描述的差不多，其中 Range 操作除了提供遍历功能外，还能够 [加速 dirty 到 readOnly.m 的升级](https://github.com/golang/sync/blob/8fcdb60fdcc0539c5e357b2308249e4e752147f1/syncmap/pre_go19.go#L318-L323)，即只要 readOnly.amended 为 true，也就是 dirty 中存在 readOnly 中不存在的 key 时，就会做 dirty 的升级操作，而不管 Map.miss 是否达到阈值。

总的来说，syncmap 还是适合多读少写的场景，进一步的，如果是更新原值的写操作也没什么，但如果存在大量的新增 key 的写操作，那 syncmap 的性能其实并不高，因为这些新的 key 都会被放在 dirty 中，而读写 dirty 是要加锁的。除此之外，频繁地增加新的 key 还可能引发多次 dirty 的升级，而每次升级后再增加新的 key 时，都会发生新 dirty 的初始化，这会产生 O(n) 的复杂度，在 k-v 数量很多的情况下会进一步影响应用的性能。

# semaphore

TBD