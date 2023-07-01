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

其实这种 fast-path + slow-path 的编码方式在 golang 标准库的好多地方都可以看到，我个人理解这样的一个好处在于外层的 Lock 方法足够简单以至于可以被内联到调用处，而一旦形成内联，那么 fast-path 就真的非常快了。

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

## 3.2. 核心数据结构

## 3.3. 写锁加锁过程

## 3.4. 写锁解锁过程

## 3.5. 读锁加锁过程

## 3.6. 读锁解锁过程

# 4. WaitGroup

## 4.1. 基本原理

## 4.2. 核心数据结构

## 4.3. Add/Done 过程

## 4.4. Wait 过程
