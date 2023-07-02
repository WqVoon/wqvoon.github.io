---
title: sync 标准库部分内容源码解读
date: 2023-07-01 17:06:08
categories:
 - [Golang]
description: 包括 Mutex、RWMutex、WaitGroup
---

# 1. 前言

之前曾经阅读过 x/sync 包的代码，这些工具在 sync 标准库的基础上封装出更贴合业务的抽象。相对比之下，sync 中提供的内容就更底层一些。最近心血来潮想继续研究下 sync 本身的一些内容，于是就有了这篇博客。本篇博客尝试从源码的角度来讨论其中的三个常用工具，并假设读者有过它们的使用经验，所以不会在使用方式上做过多说明。此外为了更加关注核心逻辑，我们下文贴出的代码会删减掉 race 相关的内容。

在介绍具体的工具前，我们需要先意识到一个问题，就是 golang 通过提供协程来向使用者屏蔽了操作系统层面的进程和线程，所以标准库中提供的各种工具也是用于做协程间同步的，这也就少不了与运行时的相互配合，这里具体来说就是信号量，事实上这篇文章所介绍的三个工具中都用到了信号量来做协程的阻塞与唤醒。我们这里不对信号量的原理做解释，只需要了解在 golang 中它能够提供的功能即可。

# 2. Mutex

## 2.1. 基本原理

Mutex 对外仅提供 Lock 和 Unlock 两个方法，并保证同一时间仅能有一个协程从 Lock 方法返回，其他与之竞争的协程在 Unlock 方法被调用前会阻塞在 Lock 方法中。但 golang 并没有限制调用 Unlock 方法的协程一定是成功从 Lock 方法返回的协程，也就是说幸运的协程 a 通过 Lock 获取到锁后，另一个协程 b 也可以调用 Unlock 来解除 a 对锁的占用。

Mutex 核心依赖 atomic 提供的原子操作以及前文提到的 runtime 提供的信号量，通过这两个工具的相互配合来对外提供便捷的方法调用。在加锁时，未能成功获取到锁的协程可能会尝试进行自旋，自旋会为它提供更多的机会来成功获取这个锁。当自旋失败时，协程就会通过信号量阻塞起来，直到锁被释放时才有机会被唤醒继续尝试加锁。由于同一时间只有一个协程能获取到锁，所以阻塞的协程会相对更多。为了避免阻塞的协程长时间获取不到锁导致的饥饿现象，golang 为 Mutex 加入了“饥饿模式”，在饥饿模式下已经阻塞过的协程会优先于新来的协程获取锁。

## 2.2. 核心数据结构

Mutex 的核心结构自然就是 Mutex 结构体，这个结构体的构成非常简单，具体如下：

```go
type Mutex struct {
	state int32
	sema  uint32
}
```

其中 sema 非常简单，仅仅用于作为信号量来实现协程的阻塞与唤醒；而 state 用于记录 Mutex 当前的状态，右边第一位代表当前 Mutex 是否已上锁，第二位代表当前是否有协程被唤醒，第三位代表当前 Mutex 是否处于“饥饿模式”，从第四位开始到最左边共计 29 位用于记录当前有多少个协程被阻塞。为了方便操作，标准库提供了一些常量来记录这些信息，具体如下：

```go
const (
	mutexLocked = 1 << iota // 取值为 1，通过“与操作”来判断是否加锁
	mutexWoken // 取值为 2，通过“与操作”来判断是否有协程被唤醒
	mutexStarving // 取值为 4，通过“与操作”来判断是否处于饥饿模式
	mutexWaiterShift = iota // 取值为 3，通过“左移右移”来从 state 中获取阻塞的协程数量
)
```

通过上面的这段描述我们就可以发现，一个零值的 Mutex 就是一个有效的初态的锁，所以我们可以简单通过 `Mutex{}` 或 `&Mutex{}` 来初始化一个锁，标准库也就没有对外提供类似 NewMutex 这样的函数。

## 2.3. 加锁过程

Mutex 的加锁被分成了两个函数：作为主体对外暴露的 Lock 方法和 Lock 内部可能调用的 lockSlow 方法。其中，Lock 方法的定义非常简单，具体如下：

```go
func (m *Mutex) Lock() {
	// Fast path: grab unlocked mutex.
	if atomic.CompareAndSwapInt32(&m.state, 0, mutexLocked) {
		return
	}
	// Slow path (outlined so that the fast path can be inlined)
	m.lockSlow()
}
```

可以看到 Lock 方法仅仅就是通过 CAS 来尝试将 state 的最低位置一，对于一个初态的锁而言这一个简单的操作就足够了，所以这被称为 fast-path。但事实上锁竞争是不可避免的，否则就不需要使用 Mutex 了，对于这类情况，流程会进入到 lockSlow 方法中。

其实这种 fast-path + slow-path 的编码方式在 golang 标准库的好多地方都可以看到，这样写的一个好处在于外层的 Lock 方法足够简单以至于可以被内联到调用处，而一旦形成内联，那么 fast-path 就真的非常快了。

回到 lockSlow，这个函数应该说是 Mutex 的核心所在了。我们直接给出这个函数的流程注释：

```go
func (m *Mutex) lockSlow() {
	var waitStartTime int64 // 如果协程陷入阻塞，记录开始阻塞的时间
	starving := false // 如果为 true，那么当前协程应该将 Mutex 设置为饥饿模式
	awoke := false // 和 mutexWoken 配合用于保证同一时间仅有一个协程被唤醒
	iter := 0 // 当前协程已经自旋的次数，在下次被唤醒时会重置
	old := m.state // 刚调用 lockSlow 时，state 的取值
	for {
		// 如果当前 Mutex 已加锁且不处于饥饿模式，并且 runtime_canSpin 返回 true，
    // 那么虽然当前协程没有获取到锁，但它被允许通过自旋来避免立即陷入阻塞
		if old&(mutexLocked|mutexStarving) == mutexLocked && runtime_canSpin(iter) {
			// 如果当前协程是新来的协程，且虽然当前有因获取不到锁而阻塞的协程，但 Mutex 还没有唤醒它们，
      // 那么尝试设置 mutexWoken，因为既然新来的协程在自旋，那么就说明已经有锁竞争，
      // 此时 Mutex 继续唤醒协程会进一步加剧锁竞争的剧烈程度
			if !awoke && old&mutexWoken == 0 && old>>mutexWaiterShift != 0 &&
				atomic.CompareAndSwapInt32(&m.state, old, old|mutexWoken) {
				awoke = true
			}
      // 自旋，实际上是调用了 pause 指令
			runtime_doSpin()
			iter++
      // 获取新的 state，因为自旋的过程中 state 的取值可能会发生变化
			old = m.state
			continue
		}
    // 以旧的 state 取值为基础，后面的流程在更新这个 new 变量，最后再通过 CAS 操作尝试更新 old
		new := old
		// 仅在非饥饿模式下，新来的协程才被允许加锁，因为饥饿模式下锁会被交给被唤醒的协程
		if old&mutexStarving == 0 {
			new |= mutexLocked
		}
    // 如果 Mutex 已经加锁或已经处于饥饿模式，那么当前协程只能乖乖陷入阻塞，
    // 但在那之前需要增加 waiter 的数量，这样 Unlock 才知道该唤醒多少个协程
		if old&(mutexLocked|mutexStarving) != 0 {
			new += 1 << mutexWaiterShift
		}
		// starving 是在当前协程被唤醒时才有可能更新的，而一旦它为 true，就代表 Mutex 需要进入饥饿模式
		if starving && old&mutexLocked != 0 {
			new |= mutexStarving
		}
    // 如果当前协程设置过 mutexWoken 或当前协程是被 Unlock 唤醒的，那么 awoke 取值为 true，
    // 此时这个协程需要取消设置 mutexWoken，否则就不会有协程被 Unlock 唤醒了
		if awoke {
			if new&mutexWoken == 0 {
				throw("sync: inconsistent mutex state")
			}
			new &^= mutexWoken
		}
    // 尝试用 CAS 更新 state
		if atomic.CompareAndSwapInt32(&m.state, old, new) {
      // 如果 old 既不是饥饿模式也没有上锁，那么 new 一定是设置了 mutexLocked 的，
      // 而能够执行到这里就说明 CAS 成功了，也就是说当前协程获取到了锁，直接返回即可
			if old&(mutexLocked|mutexStarving) == 0 {
				break
			}
			// 如果 waitStartTime 不为 0，那么说明当前协程此前阻塞过，此时要将当前协程放在阻塞队列的队首，
      // 这样下次会优先唤醒当前协程，避免饥饿现象
			queueLifo := waitStartTime != 0
      // 如果 waitStartTime 为 0，说明当前协程还未阻塞过，
      // 此时向该变量写入当前时间用于区分那些未阻塞过的协程
			if waitStartTime == 0 {
				waitStartTime = runtime_nanotime()
			}
      // 通过信号量将当前协程阻塞
			runtime_SemacquireMutex(&m.sema, queueLifo, 1)
      
      // 能执行到这里，说明当前协程被唤醒了，此时判断当前协程的阻塞时间是否已经大于 starvationThresholdNs，
      // 如果为 true，那么将 starving 置为 true，此后这个协程会将 Mutex 切换为饥饿模式
			starving = starving || runtime_nanotime()-waitStartTime > starvationThresholdNs
			old = m.state
      // 如果当前 Mutex 已经是饥饿模式了，那么其他协程不会尝试获取锁，当前协程的优先级更高
			if old&mutexStarving != 0 {
				if old&(mutexLocked|mutexWoken) != 0 || old>>mutexWaiterShift == 0 {
					throw("sync: inconsistent mutex state")
				}
        // 从后面的 unlockSlow 可以看到，饥饿模式下唤醒协程后不会减少 waiter 的数量，
        // 所以当前协程需要自己来设置这个新的值
				delta := int32(mutexLocked - 1<<mutexWaiterShift)
        // 如果当前协程的阻塞时长还没达到 starvationThresholdNs，或当前协程是最后一个 waiter，
        // 那么取消 Mutex 的饥饿模式，因为饥饿模式太低效了，新的协程根本没有机会获得锁
				if !starving || old>>mutexWaiterShift == 1 {
					delta -= mutexStarving
				}
        // 一旦进入饥饿模式，新的协程都只会增加 waiter，而不会操作 delta 中依赖的部分，
        // 所以这里可以放心地用 AddInt32 而不需要用 CAS
				atomic.AddInt32(&m.state, delta)
				break
			}
			awoke = true
			iter = 0
		} else {
      // 如果失败，取 state 的最新值，重新执行 for 循环，
      // 因为没有重置 iter，所以当前协程不会再进行自旋
			old = m.state
		}
	}
}
```

## 2.4. 解锁过程

解锁过程同加锁过程一样，也是由 Unlock 和 unlockSlow 来配合实现的，但解锁相较于加锁要简单很多：

```go
func (m *Mutex) Unlock() {
	// 对一个未加锁的 Mutex 调用 Unlock 属于运行时错误，unlockSlow 会直接 panic，
  // 所以这里就先放心地通过 AddInt32 去掉 mutexLocked
	new := atomic.AddInt32(&m.state, -mutexLocked)
  // 如果不为 0，那么说明当前 Mutex 有 waiter，此时需要进入 unlockSlow，
  // 否则 Unlock 就算结束了，Mutex 经过这个操作后会回归初态
	if new != 0 {
		m.unlockSlow(new)
	}
}

func (m *Mutex) unlockSlow(new int32) {
  // 如上所述，如果这个条件成立，那么说明使用者对一个未加锁的 Mutex 调用了 Unlock，
  // 这是不被允许的，所以会直接 panic
	if (new+mutexLocked)&mutexLocked == 0 {
		throw("sync: unlock of unlocked mutex")
	}
  // 如果当前未处于饥饿模式
	if new&mutexStarving == 0 {
		old := new
		for {
      // 如果当前已经没有 waiter，或者 Mutex 又被上了锁，
      // 或者新来的协程设置了 mutexWoken 标记，
      // 或者其他协程将当前 Mutex 设置为饥饿模式，
      // Unlock 都不该唤醒新的协程，此时直接返回即可
			if old>>mutexWaiterShift == 0 || old&(mutexLocked|mutexWoken|mutexStarving) != 0 {
				return
			}
			// 否则唤醒一个协程，让这个协程参与到锁竞争中去
			new = (old - 1<<mutexWaiterShift) | mutexWoken
			if atomic.CompareAndSwapInt32(&m.state, old, new) {
				runtime_Semrelease(&m.sema, false, 1)
				return
			}
			old = m.state
		}
	} else {
		// 饥饿模式下直接唤醒一个协程，waiter 的修改交给协程自己来做
		runtime_Semrelease(&m.sema, true, 1)
	}
}

```

# 3. RWMutex

## 3.1. 基本原理

和 Mutex 不同，RWMutex 将加锁解锁这一操作细分成读锁和写锁，在使用效果上，同一时间可以有多个协程持有读锁，但仅会有一个协程持有写锁。但正是由于这一点，所以读锁相对写锁而言更容易获取，因为两次读锁之间不会有锁冲突，这很可能导致试图加写锁的协程饥饿，也就是长时间获取不到写锁。

为了避免这种现象，RWMutex 会保证当一个协程尝试获取写锁后，尽管它可能会失败，但在其之后尝试获取读锁的协程都没办法成功获取到锁，直至已经持有读锁的协程释放了锁，前面尝试获取写锁的协程拿到并释放锁后，这些新来的协程才能继续获取读锁。

## 3.2. 核心数据结构

RWMutex 的核心数据结构也很简单，并且同 Mutex 一样，一个零值的结构体就是一个初态的读写锁，结构体的具体字段如下：

```go
type RWMutex struct {
	w           Mutex  // 用于做写锁之间的排他锁，保证在 RWMutex.Unlock 执行之前，RWMutex.Lock 方法只能被执行一次
	writerSem   uint32 // 写锁的 waiter 使用的信号量，写锁 acquire，读锁 release
	readerSem   uint32 // 读锁的 waiter 使用的信号量，读锁 acquire，写锁 release
	readerCount int32  // 当前有多少协程获取了读锁，这个字段还有一些其他的用途，我们下面会看到
	readerWait  int32  // 在某个协程尝试加写锁时，有多少协程已经获取到了读锁，如果这个值不为 0，那么这个获取写锁的协程需要阻塞直到这些协程均释放了持有的读锁
}

```

除了这个结构体外，还有一个很重要的常量定义 `const rwmutexMaxReaders = 1 << 30`，这个东西是用来与 readerCount 字段配合使用的，具体而言，我们前面提到当一个协程尝试获取写锁但失败时，它会陷入阻塞，但在它之后的所有尝试获取读锁的协程都会阻塞。为了达成这个效果，我们就需要在尝试获取写锁时，在 RWMutex 加一个标记表示有协程在尝试获取写锁，这个标记在实现上是通过 readerCount 与 rwmutexMaxReaders 来相互配合的。当协程尝试加写锁时，会将 readerCount 减掉 rwmutexMaxReaders，这会导致 readerCount 变成一个很小的负数，这样在协程尝试加读锁时，一旦检测到这个值是负数，那么它就知道现在有协程在尝试获取写锁，此时它就应该乖乖地降低自己的优先级。

## 3.3. 写锁加锁过程

```go
func (rw *RWMutex) Lock() {
	// 先将 w 加锁，直到 rw.Unlock 被调用时才会调用 rw.w.Unlock，
  // 保证在这期间只有一个协程能够拿到写锁
	rw.w.Lock()

	// 这里原子性地做了两件事情，首先通过 AddInt32 将 readerCount 减掉 rwmutexMaxReaders，
  // 这样做会通知其他协程“当前有协程在尝试获取写锁”，此后尝试获取读锁的协程都应该阻塞，
  // 另外，AddInt32 会返回 readerCount 的新值，将这个值增加 rwmutexMaxReaders，
  // 就可以拿到 AddInt32 之前的值
	r := atomic.AddInt32(&rw.readerCount, -rwmutexMaxReaders) + rwmutexMaxReaders
  
	// 如果此前 readerCount 不为 0，那么它一定大于 0，因为 rw.RLock 会增加这个值，
  // 而 rw.RUnlock 会减少这个值，所以大于 0 时代表当前还有协程没有释放读锁，
  // 这时应该将这个值增加到 readerWait 上，然后将当前协程阻塞，
  // rw.RUnlock 会减少 readerWait，减为 0 时会释放信号量来唤醒协程，
  // 此后 rw.Lock 返回，RWMutex 成功加写锁
	if r != 0 && atomic.AddInt32(&rw.readerWait, r) != 0 {
		runtime_SemacquireMutex(&rw.writerSem, false, 0)
	}
}
```

## 3.4. 写锁解锁过程

```go
func (rw *RWMutex) Unlock() {
	// 将 readerCount 变回正数，通知其他 reader 当前没有 writer 在等着获取锁，
  // 这样当新的 reader 想获取读锁时，不需要陷入阻塞
	r := atomic.AddInt32(&rw.readerCount, rwmutexMaxReaders)
  
  // 如果 r 的值大于等于 rwmutexMaxReaders，那么说明对一个没有上写锁的 RWMutex
  // 调用了 Unlock，这是不正确的运行时错误，所以要 panic
	if r >= rwmutexMaxReaders {
		throw("sync: Unlock of unlocked RWMutex")
	}
  
	// r 如果大于 0 那一定是在调用 Lock 之后调用的 RLock 导致的，
  // 因为在这之前的 RLock 优先级都比 Lock 高，而既然现在在执行 Unlock，
  // 那么说明 Lock 也已经成功执行了，
  // 进而说明 Lock 前面的 RLock 对应的 RUnlock 也都执行完了，
  // 对于这些后执行的 RLock 来说，由于其优先级比 Lock 低，
  // 所以都会因为 acquire readerSem 而导致阻塞，在 Unlock 时要进行 release
	for i := 0; i < int(r); i++ {
		runtime_Semrelease(&rw.readerSem, false, 0)
	}

  // 释放 w，运行其他协程尝试获取写锁
	rw.w.Unlock()
}
```

## 3.5. 读锁加锁过程

```go
func (rw *RWMutex) RLock() {
  // 加读锁仅仅是原子增加 readerCount 的值，如果增加后的结果小于 0，
  // 那么说明在此之前有一个 writer 在尝试获取写锁，不论它是否成功获取到，
  // 当前的协程都应该阻塞
	if atomic.AddInt32(&rw.readerCount, 1) < 0 {
		runtime_SemacquireMutex(&rw.readerSem, false, 0)
	}
}
```

## 3.6. 读锁解锁过程

```go
func (rw *RWMutex) RUnlock() {
  // RUnlock 的核心操作是减少 readerCount，如果减少后的结果小于 0，
  // 那么说明当前的协程在一个 writer 之前获取到了读锁，
  // 而这个 writer 正在等待当前的协程，
  // 也就是说 rw.readerWait 中的其中一个就是当前协程，此时需要特殊处理
	if r := atomic.AddInt32(&rw.readerCount, -1); r < 0 {
		rw.rUnlockSlow(r)
	}
}

func (rw *RWMutex) rUnlockSlow(r int32) {
  // 如果 r+1==0，说明 readerCount 在减少之前是 0，
  // 但 RLock 方法一定会增加 readerCount，所以这就代表使用者在对未加锁的 RWMutex 解锁；
  // 另外，r 也不可能小于 -rwmutexMaxReaders，因为 rw.Lock 方法通过 rw.w 保证其在 rw.Unlock 之前只会被一个协程调用，
	// 所以如果出现这种情况也同样是有问题的，此时直接 panic
	if r+1 == 0 || r+1 == -rwmutexMaxReaders {
		throw("sync: RUnlock of unlocked RWMutex")
	}

  // 如前所述，如果能进到 rUnlockSlow 中，说明当前协程是 rw.readerWait 的一份子，
  // 所以在当前协程释放读锁后应该减少 rw.readerWait，而一旦这个值为 0，
  // 就说明 writer 之前的所有协程都释放了读锁，此时应该通过信号量来唤醒这个 writer
	if atomic.AddInt32(&rw.readerWait, -1) == 0 {
		runtime_Semrelease(&rw.writerSem, false, 1)
	}
}
```

# 4. WaitGroup

## 4.1. 基本原理

WaitGroup 适合某个/些协程“等待”另一个/些协程的场景，比如一个主协程分出 n 个子协程去调不同的 rpc，然后 Wait 这些协程直到它们全部返回，再收集这些调用结果；亦或是一个主协程去做一些事，多个子协程在 Wait 它把这件事做完。总而言之，Add/Done 被那些“做某件事”的协程调用，Wait 则被那个“等待结果”的协程调用。

但 Add 方法并不限制传入的值一定是 1，所以 WaitGroup 的使用方式非常灵活。这就要求我们需要记录当前某个 WaitGroup Add 了多少，相应的需要调用同样多次 Done 才能让调用 Wait 的协程被唤醒。而调用 Wait 的协程又可能不止一个，所以我们还需要记录这个数量，在 Done 的调用次数达标时，这些协程都应该被唤醒。

## 4.2. 核心数据结构

WaitGroup 的核心数据结构虽然定义很简单，但理解起来却有一定难度，和前两个结构体一样，一个零值的结构体就是一个初态的 WaitGroup，这个结构体的定义如下：

```go
type WaitGroup struct {
	noCopy noCopy
	state1 [3]uint32
}
```

首先是 noCopy 这个结构，顾名思义，它用于检查 WaitGroup 被创建后是否被复制，一旦某个 WaitGroup 被复制，`go vet` 工具就可以将这个复制操作检查出来。

然后是 state1 这个结构，它最终是通过 WaitGroup.state 这个方法来使用的，这个方法的定义是这样的：

```go
func (wg *WaitGroup) state() (statep *uint64, semap *uint32) {
  // 如果 state1 的起始地址是 64 位对齐的
	if uintptr(unsafe.Pointer(&wg.state1))%8 == 0 {
    // 那么用 state1 前两个位置作为一个 uint64，最后一个位置作为一个 uint32
		return (*uint64)(unsafe.Pointer(&wg.state1)), &wg.state1[2]
	} else {
    // 否则用 state1 的后两个位置作为一个 uint64，
    // 此时这个 uint64 的起始地址是 64 位对齐的，
    // 然后用第一个位置作为一个 uint32
		return (*uint64)(unsafe.Pointer(&wg.state1[1])), &wg.state1[0]
	}
}
```

可以看到，state1 最终会通过 state 方法拆解出 state 和 sema 两个值，前者用于记录 WaitGroup 的状态，后者作为信号量来实现协程的阻塞与唤醒。和 Mutex 不同，这里的 state 需要是 64 位的，因为它前 32 位记录 Add 的总量，后 32 位记录 Wait 的协程数量，如果仍然使用 32 位的 state，那么这两个内容的最大值都会很受限。

而一旦 state 是 64 位的，那我们就需要通过 64 位的原子操作来操作这个字段，但 64 位的原子操作要求被操作数的地址是 64 位对齐的，也就是首地址模 8 需要为 0。64 位系统的编译器会保证这一点，但 32 位系统的编译器却只保证操作数地址是 32 位对齐的，也就是说可能出现操作数首地址模 8 后等于 4 的情况。所以为了在这样的情况下仍然能够原子性地操作 uint64，就需要手动进行内存对齐，也就是跳过 state1 的前 32 位。

## 4.3. Add/Done 过程

WaitGroup.Done 实际上就是 WaitGroup.Add(-1)，所以我们这里仅给出 Add 方法的代码解读：

```go
func (wg *WaitGroup) Add(delta int) {
	statep, semap := wg.state()

  // 将 Add 的入参增加到 state 的高 32 位，delta 可正可负
	state := atomic.AddUint64(statep, uint64(delta)<<32)
  // 获取增加后的 Add 总量
	v := int32(state >> 32)
  // 从 state 的低 32 位获取当前调用了 Wait 的协程数量
	w := uint32(state)
  // Add 总量不能小于 0，否则 Done 就永远无法结束了
	if v < 0 {
		panic("sync: negative WaitGroup counter")
	}
  
  // 如果 delta 大于 0 且当前 Add 的总量就是 delta，那么说明是第一次调用 Add，此时 waiter 应该为 0，
  // 否则说明 Wait 和 Add 同时被调用了，这属于运行时错误，所以需要 panic
	if w != 0 && delta > 0 && v == int32(delta) {
		panic("sync: WaitGroup misuse: Add called concurrently with Wait")
	}
  // 如果 Add 总量仍大于 0，或根本就没有 waiter，那么此时不需要唤醒 waiter，直接退出就好
	if v > 0 || w == 0 {
		return
	}
  // 否则 v 一定等于 0 且 waiter 不为 0，那么此时 Done 的数量已经达标，需要唤醒所有的 waiter
  
  // 如果这两个值不相等，说明在当前 Add 执行期间其他协程调用了 Add 或 Wait，此时算作运行时错误
	if *statep != state {
		panic("sync: WaitGroup misuse: Add called concurrently with Wait")
	}

  // 重置 state，并将所有的 waiter 都唤醒
	*statep = 0
	for ; w != 0; w-- {
		runtime_Semrelease(semap, false, 0)
	}
}
```

## 4.4. Wait 过程

```go
func (wg *WaitGroup) Wait() {
	statep, semap := wg.state()

	for {
    // 获取 Add 的总量和 waiter 的数量
		state := atomic.LoadUint64(statep)
		v := int32(state >> 32)
		w := uint32(state)
    
    // 如果 Add 的总量已经为 0，那么说明 Done 的数量已经达标，此时 Wait 直接返回
		if v == 0 {
			return
		}
    
		// 否则说明 Done 还未达标，需要原子增加 waiter 的数量，并将当前协程阻塞
		if atomic.CompareAndSwapUint64(statep, state, state+1) {
			runtime_Semacquire(semap)
      // 由于在 release semap 前已经将 state 置为 0，所以执行到这里时也应该是 0，
      // 如果不为 0，那么说明 state 在所有 waiter 被唤醒前就被复用了，此时算作运行时错误
			if *statep != 0 {
				panic("sync: WaitGroup is reused before previous Wait has returned")
			}
			return
		}
	}
}

```
