---
title: finalizer 与内存泄漏与 gc tuner
date: 2023-07-26 00:22:10
categories:
 - [Golang]
description: 分析 1.16 版本的 Finalizer 相关源码，包括设置、执行、可能会导致的一些问题以及 gc tuner 中对该技术的应用
---

# 前言

golang 是一门 GC 类语言，所以开发者无需关心内存管理相关的问题，因为不再被使用的内存会自动被垃圾回收器清理掉。针对 GC 管理的堆内存空间，golang 对开发者提供了 Finalizer 机制，当某部分内存被认为是无用内存时，与之关联的 Finalizer 就会被 runtime 执行。这样对开发者来说，Finalizer 就相当于是 GC 的钩子函数，可以在绑定的函数中写一些资源回收类的操作。

本文针对 Finalizer 的相关代码进行分析，并讨论这项技术可能导致的一些问题，由于篇幅原因，在分析代码时会只关注核心逻辑。

# 概述

Finalizer 相当于是 GC 的钩子，所以它的执行流程中自然少不了 GC 的参与。具体来说，golang 采用的垃圾回收算法是标记清除算法，如果一个对象设置了 Finalizer，那么在标记阶段需要将该对象中所有指针类字段指向的内存标记为可达，因为 Finalizer 绑定的函数唯一的入参就是这个对象，那么就需要保证这个对象内部的字段都是可用的；另一方面，Finalizer 在垃圾回收的清除阶段才会被执行，对应的对象在本次垃圾回收时会重新被标记为存活，直到对应的 Finalizer 函数执行完毕后，这个对象对应的内存才会被释放（即便在这个期间有新一轮的 GC 被触发，这个用户侧不可达的对象也不会被清理，因为 Finalier 中保存有这个对象的指针，而 Finalizer 是一种 root 对象，所以扫描 Finalizer 时就会把这个对象标记为可达的）。

golang 的 runtime 使用一个独立的协程来串行执行所有的 Finalizer，这个协程平时处于休眠状态，GC 的清除阶段如果发现有需要执行的 Finalizer，那么会设置一个标记位（runtime.fingwake），在协程调度阶段，`runtime.findrunnable` 函数负责确保“一定会找到一个可执行的协程”，其中就会判断这个标记位，并按需将这个负责执行 Finalizer 的协程运行在当前的 M 上。

回到 Finalizer 本身上，它是怎么和对象关联起来的呢？golang 的内存模型中，runtime.mspan 是最细粒度的内存管理单元，每个 mspan 结构管理一块内存，这块内存被划分成多个相同规格的小内存，所以被 mspan 管理的每一块小内存都有自己的 offset（相当于是小内存数组的下标）；而 mspan 这个结构体中有一个 specials 字段，这是一个 special 结构的链表，golang 中有许多 special，Finalizer 就是其中一种。special 结构中有一个 offset 字段，这个 offset 正是前面提到的某块小内存对应的 offset。总结来说，给定一个 offset，我们能从 mspan 管理的内存中找到某块小内存，也能从 specials 链表中找到对应的 Finalizer（如果有的话），而这个小内存在用户侧的表现就是一个对象，因此这个 offset 就把某个对象和 Finalizer 联系起来了。

有了这些背景知识，我们就可以一起来看一下相关的代码了。

# 设置与取消设置 Finalizer

golang 对开发者只暴露了 `runtime.SetFinalizer` 一个函数来操作 Finalizer，第一个参数是想要绑定 Finalier 的对象，这个参数需要是一个指针，而第二个参数则相对灵活，当它是一个符合条件的函数时，`runtime.SetFinalier` 被用于设置 Finalizer；而当第二个参数是 nil 时，该函数就被用于取消设置 Finalizer。同一个对象只能被设置一次 Finalizer，重复设置会导致 panic。下面直接来看一下关键部分的代码：

```go
func SetFinalizer(obj interface{}, finalizer interface{}) {
  // 确保 obj 是指针类型，且指向堆内存空间
	...

	f := efaceOf(&finalizer)
	ftyp := f._type
	if ftyp == nil {
		// 如果第二个参数传了个 nil 进来，那么就调用 removefinalizer 移除掉已经存在的 Finalizer
		systemstack(func() {
			removefinalizer(e.data)
		})
		return
	}

	// 确保第二个参数的类型是正确的
 	...

okarg:
	// 计算 finalizer 这个函数的返回值需要多大的内存，因为在调用它时会构建一个假的栈帧，
  // 但是实际上这个返回值没有任何作用
	nret := uintptr(0)
	for _, t := range ft.out() {
		nret = alignUp(nret, uintptr(t.align)) + uintptr(t.size)
	}
	nret = alignUp(nret, sys.PtrSize)

	// 创建一个协程，这个协程会在后台串行执行所有的 Finalizer
	createfing()

  // 调用 addfinalizer 将 obj 与 finalizer 绑定起来，仅在 obj 已经绑定过 finalizer 时返回 false，
  // 由于一个对象只能与一个 finalizer 绑定，所以程序会直接 panic
	systemstack(func() {
		if !addfinalizer(e.data, (*funcval)(f.data), nret, fint, ot) {
			throw("runtime.SetFinalizer: finalizer already set")
		}
	})
}
```

## 设置 Finalizer

`runtime.SetFinalizer` 在验证参数合法后会调用 `runtime.addfinalizer` 来完成对象与 Finalizer 的绑定：

```go
func addfinalizer(p unsafe.Pointer, f *funcval, nret uintptr, fint *_type, ot *ptrtype) bool {
  // 获取一块内存用于保存 specialfinalizer 对象，specialfinalizeralloc 是一个 fixalloc 结构，
  // mheap 有很多 fixalloc，这是一个简单的带缓存的内存分配器，非并发安全所以需要加锁
	lock(&mheap_.speciallock)
	s := (*specialfinalizer)(mheap_.specialfinalizeralloc.alloc())
	unlock(&mheap_.speciallock)
  
  // 设置内部字段，这个 fn 就是传进来的 finalizer 函数，这里是一个 funcval 结构，
  // 而 gc 的标记阶段会扫描这个 funcval，所以 finalizer 如果是个闭包函数，闭包捕获的变量也会存活
	s.special.kind = _KindSpecialFinalizer
	s.fn = f
	s.nret = nret
	s.fint = fint
	s.ot = ot
  
  // 将 special 与 p 地址对应的对象关联起来，这里虽然绑定的是 s.special，
  // 但是由于 special 是 specialfinalizer 结构起始的字段，所以它们实际拥有同样的地址，
  // 那么根据 special 就可以通过 unsafe.Pointer 强制转换回 specialfinalizer，
  // 后面在执行的时候就是用这个原理来根据 special 拿到的 specialfinalizer
	if addspecial(p, &s.special) {
		if gcphase != _GCoff {
			base, _, _ := findObject(uintptr(p), 0, 0)
			mp := acquirem()
			gcw := &mp.p.ptr().gcw
			// 确保 p 对应对象内部的所有指针对象都被标记存活，因为在调用 finalier 时要用到这个对象
			scanobject(base, gcw)
			// 扫描 funcval，所以如果有闭包捕获的变量也会被标记存活
			scanblock(uintptr(unsafe.Pointer(&s.fn)), sys.PtrSize, &oneptrmask[0], gcw, nil)
			releasem(mp)
		}
		return true
	}

	// 如果执行到这里，那么 addspecial 返回了 false，而它只有 p 对应的对象已经绑定 Finalizer 时才会返回 false，
  // 所以这里返还前面 alloc 得到的内存，向 caller 返回 false，caller（SetFinalizer）会直接 panic
	lock(&mheap_.speciallock)
	mheap_.specialfinalizeralloc.free(unsafe.Pointer(s))
	unlock(&mheap_.speciallock)
	return false
}
```

`runtime.addspecial` 用于在 mspan 层面将 p 对应的内存与 special 绑定起来：

```go
func addspecial(p unsafe.Pointer, s *special) bool {
  // 根据指针反查对应的 mspan 结构，如果 span 为 nil，那么说明 p 指向的内存不属于堆内存空间，
  // 不过前面 SetFinalizer 验证过这个问题，所以对于 Finalizer 而言应该不会出现 nil 的情况
	span := spanOfHeap(uintptr(p))
	if span == nil {
		throw("addspecial on invalid pointer")
	}

	// 按需和 gc 同步，确保在当前 mspan 的 gc 清理阶段不会新增 special，
  // 因为 mspan 的清扫阶段会读内部的 specials 链表，找到需要执行的 special（包括 Finalier），
  // 而这个读操作没有加锁
	mp := acquirem()
	span.ensureSwept()

  // 获取 p 相对于 mspan 基地址的偏移量，我们前面提到过，这个 offset 用于将 p 与 Finalizer 联系起来
	offset := uintptr(p) - span.base()
	kind := s.kind

	lock(&span.speciallock)

	t := &span.specials
	for {
		x := *t
		if x == nil {
			break
		}
    // 如果 offset 和 kind 都相同，就说明 p 对应的地址已经绑定过 Finalier 了，
    // 此时向 caller 返回 false
		if offset == uintptr(x.offset) && kind == x.kind {
			unlock(&span.speciallock)
			releasem(mp)
			return false
		}
    // 这个操作一方面能让 for 循环提前结束，一方面能保证 specials 链表中的元素是有序的
		if offset < uintptr(x.offset) || (offset == uintptr(x.offset) && kind < x.kind) {
			break
		}
		t = &x.next
	}

	// 将新的 special 加入到链表中合适的位置，标记 mspan 有 special，这样就完成了 Finalier 的绑定操作
	s.offset = uint16(offset)
	s.next = *t
	*t = s
	spanHasSpecials(span)
	unlock(&span.speciallock)
	releasem(mp)

	return true
}
```

## 取消 Finalizer

如果 `runtime.SetFinalizer` 的第二个参数是一个 nil，那么最终这个函数会调用 `runtime.removefinalizer`，从而解除对象与其 Finalizer 的绑定关系，与设置 Finalizer 不同，取消绑定这一操作是幂等的，重复调用也不会导致程序 panic。下面一起来看下 `runtime.removefinalizer` 的代码：

```go
func removefinalizer(p unsafe.Pointer) {
  // 调用 removespecial 来移除 _KindSpecialFinalizer 类型的 special，其实就是 Finalizer
	s := (*specialfinalizer)(unsafe.Pointer(removespecial(p, _KindSpecialFinalizer)))
	if s == nil {
		return // 如果没找到与对象绑定的 Finalizer 就直接返回，这里就是幂等的
	}
  
  // 这里的 free 并没有将内存还给操作系统，而是将其缓存起来方便下次 alloc 时复用
	lock(&mheap_.speciallock)
	mheap_.specialfinalizeralloc.free(unsafe.Pointer(s))
	unlock(&mheap_.speciallock)
}
```

与 `runtime.addspecial `相反 ， `runtime.removespecial` 的作用是在 mspan 层面将 p 对应的内存与已经存在的 special 解绑：

```go
func removespecial(p unsafe.Pointer, kind uint8) *special {
  // 获取 p 内存所在的 mspan 结构体
	span := spanOfHeap(uintptr(p))
	if span == nil {
		throw("removespecial on invalid pointer")
	}

	// 和 addspecial 一样，这里也需要确保当前 mspan 的 GC 的清扫已经完成
	mp := acquirem()
	span.ensureSwept()

  // 计算 offset，这个 offset 用于寻找对应的 Finalizer
	offset := uintptr(p) - span.base()

	var result *special
	lock(&span.speciallock)
	t := &span.specials
  // 遍历 specials 链表，找到 offset 对应的 Finalizer，
  // 但是其实 special 结构是按 offset 排序的，所以这里可以不完全遍历整条链表
	for {
		s := *t
		if s == nil {
			break
		}
		if offset == uintptr(s.offset) && kind == s.kind {
			*t = s.next
			result = s
			break
		}
		t = &s.next
	}
  
  // 如果当前的 mspan 已经没有 specials 了，那么就调用 spanHasNoSpecials 标记它
	if span.specials == nil {
		spanHasNoSpecials(span)
	}
	unlock(&span.speciallock)
	releasem(mp)
  
  // 返回找到的结果，或者如果没找到就返回一个 nil
	return result
}
```

# 执行 Finalizer

在 `runtime.SetFinalizer` 中，如果尝试给某个对象绑定 Finalizer，那么流程中会走到 `runtime.createfing` 函数，这个函数的内容是这样的：

```go
func createfing() {
	// 通过全局的 fingCreate 函数来确保 if 块中的逻辑只被执行一次
	if fingCreate == 0 && atomic.Cas(&fingCreate, 0, 1) {
		go runfinq()
	}
}
```

而 `runtime.runfinq` 是被另一个 gouroutine 来执行的，这就是我们说的那个会负责串行执行所有 Finalizer 函数的 goroutine，我们来重点看它前半部的代码：

```go
func runfinq() {
  // 先不管这两个变量，这是执行 Finalizer 时才会用到的，用于构造假的栈帧
	var (
		frame    unsafe.Pointer
		framecap uintptr
	)

  // 整个函数是一个永不停止的 for 循环
	for {
    // 下面这些 finq、fing 都是全局变量，而 finlock 用于确保这些全局变量变更时的原子性
		lock(&finlock)
    
    // 获取当前 finq 中的内容，finq 中会保存所有的待执行 Finalizer 函数，
    // 这个变量的赋值逻辑我们后面会提到
		fb := finq
		finq = nil
    
    // 当前没有待执行的 Finalizer，陷入休眠
		if fb == nil {
			gp := getg()
			fing = gp
      // 设置 fingwait，代表当前有负责执行 Finalizer 的 goroutine 在等待被调度执行
			fingwait = true
      // 调用 gopark 将当前 goroutine 挂起，当前的 m 会去执行其他的 goroutine
			goparkunlock(&finlock, waitReasonFinalizerWait, traceEvGoBlock, 1)
			continue
		}
		unlock(&finlock)

    ... // 执行 fb 中所有的 Finalizer
	}
}
```

可以发现，fing 这个 goroutine 一直在一个永不停止的 for 循环中打转，每次循环时尝试从 finq 中拿到待执行的 Finalizer 并去执行它们，而如果 finq 是空的，那么就设置 fingwait 并将 fing 挂起。不难想到，只有 finq 中有内容后才应该唤醒 fing，否则就没有任何意义。所以现在我们就需要关注两个点，第一是 finq 中什么时候有内容，第二是如何唤醒 fing。

先来看什么时候有内容，GC 的清理阶段最终会落实到每一个 msapn 上，具体来说是会调用到 `mspan.sweep` 这个方法。在这个方法中有这样一段逻辑：

```go
func (s *mspan) sweep(preserve bool) bool {
	...

  // mspan 中保存的小内存块大小
  size := s.elemsize

	hadSpecials := s.specials != nil
	specialp := &s.specials
	special := *specialp
	for special != nil {
    // 获取 offset 对应对象在 mspan 中的下标，因为比如对于 struct{a, b int} 这样的对象而言，
    // a 和 b 均可以设置 Finalizer，但是整个 struct 在 GC 的清扫阶段是被看作一个整体的，
    // 所以内部字段绑定的 Finalizer 均会被执行，然后需要把整个 struct 标记为存活（这需要知道下标），
    // 通过整数除法的方式可以根据 a 和 b 的地址获取整个 struct 在 mspan 中的下标
		objIndex := uintptr(special.offset) / size
		p := s.base() + objIndex*size
    
    // 根据对象的下标获取对应的标记位图
		mbits := s.markBitsForIndex(objIndex)
    // 如果没有标记，说明这个对象在用户侧没有来自 root 对象的引用，在没有 Finalizer 的情况下应该被删除
		if !mbits.isMarked() {
			hasFin := false
			endOffset := p - s.base() + size
      
      // special 是根据 offset 从小到大排序的，所以可以把 endOffset 作为循环结束条件
			for tmp := special; tmp != nil && uintptr(tmp.offset) < endOffset; tmp = tmp.next {
				if tmp.kind == _KindSpecialFinalizer {
					// 发现对象有 Finalizer，需要将对应的对象标记存活，让它至少再活一轮 GC
					mbits.setMarkedNonAtomic()
					hasFin = true
					break
				}
			}
			
			for special != nil && uintptr(special.offset) < endOffset {
				p := s.base() + uintptr(special.offset)
				if special.kind == _KindSpecialFinalizer || !hasFin {
          // 从链表中删除这个 special，然后把相关信息传递给 freespecial，
          // 这个 freespecial 就是将 Finalizer 放到 finq 中的关键函数
					y := special
					special = special.next
					*specialp = special
					freespecial(y, unsafe.Pointer(p), size)
				} else {
					specialp = &special.next
					special = *specialp
				}
			}
		} else {
			// 被标记了，说明对象经历了这轮 GC 后依然存活，所以不需要执行 Finalizer
			specialp = &special.next
			special = *specialp
		}
	}
  // 如果之前当前 mspan 有 special 但经历了上面的循环后没有 special，
  // 那么调用 spanHasNoSpecials 标记
	if hadSpecials && s.specials == nil {
		spanHasNoSpecials(s)
	}
```

从链表上取下来的 Finalizer 会被送到 `runtime.freespecial` 这个函数中，事实上其他的 special 也在这里被处理，不过我们只关注 Finalizer 的部分：

```go
func freespecial(s *special, p unsafe.Pointer, size uintptr) {
	switch s.kind {
	case _KindSpecialFinalizer:
    // 这里印证了前面的结论，虽然入参的 s 是一个 special，但实际它是 specialfinalizer 的一部分，
    // 且是它的第一个字段，所以两者拥有相同的地址，可以通过 unsafe.Pointer 强转，
    // golang 虽然不希望对使用者暴露太多指针的概念，但这种强转确实好用且高效，
    // 这也是在 c 语言中实现多态的有效手段
		sf := (*specialfinalizer)(unsafe.Pointer(s))
    // 使用转换出来的 specialfinalizer 结构调用 queuefinalizer 函数
		queuefinalizer(p, sf.fn, sf.nret, sf.fint, sf.ot)
    // 调用结束后，“回收” specialfinalizer 对应的内存，fixalloc 会将其缓存方便下次使用
		lock(&mheap_.speciallock)
		mheap_.specialfinalizeralloc.free(unsafe.Pointer(sf))
		unlock(&mheap_.speciallock)
	
  ...
    
	default:
		throw("bad special kind")
		panic("not reached")
	}
}
```

`runtime.freespecial` 根据 kind 字段的取值把入参的 special 结构转换成具体的 special 然后分别处理，针对 Finalizer 就是调用 `runtime.queuefinalizer` 函数，这个函数的逻辑是这样的：

```go
func queuefinalizer(p unsafe.Pointer, fn *funcval, nret uintptr, fint *_type, ot *ptrtype) {
	if gcphase != _GCoff {
    // GC 的清扫阶段对应的 gcPhase 是 GCoff，需要确保状态是对的
		throw("queuefinalizer during GC")
	}

  // 下面反正就是往 finq 里塞东西，有个 finc 是缓存 finblock 结构用的，
  // 设计思路类似于 fixalloc，把上层认为可以回收的内存缓存起来给下次用
	lock(&finlock)
	if finq == nil || finq.cnt == uint32(len(finq.fin)) {
		if finc == nil {
			finc = (*finblock)(persistentalloc(_FinBlockSize, 0, &memstats.gcMiscSys))
			finc.alllink = allfin
			allfin = finc
			if finptrmask[0] == 0 {
				if (unsafe.Sizeof(finalizer{}) != 5*sys.PtrSize ||
					unsafe.Offsetof(finalizer{}.fn) != 0 ||
					unsafe.Offsetof(finalizer{}.arg) != sys.PtrSize ||
					unsafe.Offsetof(finalizer{}.nret) != 2*sys.PtrSize ||
					unsafe.Offsetof(finalizer{}.fint) != 3*sys.PtrSize ||
					unsafe.Offsetof(finalizer{}.ot) != 4*sys.PtrSize) {
					throw("finalizer out of sync")
				}
				for i := range finptrmask {
					finptrmask[i] = finalizer1[i%len(finalizer1)]
				}
			}
		}
		block := finc
		finc = block.next
		block.next = finq
		finq = block
	}
	f := &finq.fin[finq.cnt]
	atomic.Xadd(&finq.cnt, +1)
	f.fn = fn
	f.nret = nret
	f.fint = fint
	f.ot = ot
	f.arg = p
  
  // 注意这里设置了 fingwake 这个全局变量的值
	fingwake = true
	unlock(&finlock)
}
```

总结来说，GC 的清扫阶段将各个 mspan 上的 Finalizer 塞进了 finq 结构，这样当 fing 协程被唤醒时就可以顺利地从 finq 中获取到待执行的 Finalizer 并串行执行它们。那么现在剩下的唯一问题就是如何唤醒 fing 了，在前面分析 fing 的代码时我们看到它在陷入休眠前设置了 fingwait 这个变量，现在 `runtime.queuefinalizer` 又设置了 fingwake，现在就需要有一个地方能感知到这两个变量的变化并做实际的唤醒操作。不难想到，这应该是调度器做的事情，具体来说，`runtime.findrunnable` 会接下这个任务：

```go
func findrunnable() (gp *g, inheritTime bool) {
	...

  // 如果 fingwait 为 true 且 fingwake 也为 true，那么就调用 wakgfing，
  // 如果能获取到对应的 g 的指针（其实就是全局变量 fing），那么就调用 runtime.ready，
  // 将对应的 g 放到调度队列中等待 m 来执行它
	if fingwait && fingwake {
		if gp := wakefing(); gp != nil {
			ready(gp, 0, true)
		}
	}
  
  ...
}

func wakefing() *g {
  // 可以看到，其实就是把 fing 返回出去了
	var res *g
	lock(&finlock)
	if fingwait && fingwake {
		fingwait = false
		fingwake = false
		res = fing
	}
	unlock(&finlock)
	return res
}
```

# Finalizer 的一些问题

## 长耗时操作导致其他对象的 Finalizer 无法被执行

我们在上面分析了 Finalizer 的执行过程，可以看到只有一个 fing 在后台默默地串行执行所有的 Finalizer，所以如果有一个 Finalizer 的逻辑耗时很长，那么后面的 Finalizer 就只能等待，而即便这期间有新一轮的 GC 被执行，后面 Finalizer 绑定的对象也无法被清理，因为 Finalizer 函数的入参就是这个对象，需要保证在执行时这个对象是可用的。所以如果这个对象占用了大量的内存，那么在对应的 Finalizer 被执行前，它占用的内存就无法被释放。为了避免这种情况导致的“内存泄露”， `runtime.SetFinalizer` 的注释中也提到，如果有这种长耗时的 Finalizer，最好在内部创建一个新的 goroutine 来完成这部分逻辑。

下面是一个例子，尽管我们每秒主动触发一次 GC 操作，但 b 对象仍然要等绑定的 Finalizer 执行完毕后才能被释放：

```go
package main

import (
	"fmt"
	"runtime"
	"time"
)

func main() {
	var a, b int
	{
    // 为 a 设置一个长耗时的 Finalizer
		runtime.SetFinalizer(&a, func(interface{}) {
			fmt.Println("start to exec a finalizer")
			time.Sleep(5 * time.Second)
			fmt.Println("a finalizer finished")
		})
    // 虽然 b 的 Finalizer 耗时很短，但它需要等 a 执行完毕
		runtime.SetFinalizer(&b, func(interface{}) {
			fmt.Println("start to exec b finalizer")
			fmt.Println("b finalizer finished")
		})
	}

	for range time.NewTicker(time.Second).C {
		fmt.Println("call runtime.GC()")
		runtime.GC()
	}
}
```

执行结果：

```shell
> go run -gcflags '-N -l' .
call runtime.GC()
start to exec a finalizer
call runtime.GC()
call runtime.GC()
call runtime.GC()
call runtime.GC()
call runtime.GC()
a finalizer finished
start to exec b finalizer
b finalizer finished
call runtime.GC()
call runtime.GC()
```

## 循环引用导致内存泄漏

如果有一个对象绑定了 Finalizer，那么这个对象本身及其内部字段都要持续存活，直到对应的 Finalizer 执行完毕。如果我们构建了一个循环引用，a 是 b 的内部字段，b 是 a 的内部字段，且 a 和 b 都设置了 Finalizer，那么 b 会因为 a 的 Finalizer 而持续存活，a 会因为 b 的 Finalizer 而持续存活。这样一来，尽管用户侧已经没有了对 a 和 b 的引用，但由于前面循环引用的存在，a 和 b 都无法被释放。

下面是一个例子：

```go
package main

import (
	"fmt"
	"runtime"
	"time"
)

func main() {
	type T struct {
		ptr *T
	}

	// 构建循环引用
	a := &T{}
	b := &T{ptr: a}
	a.ptr = b // 如果把这行注释掉，就不会循环引用

	// 设置 runtime.SetFinalizer
	{
		runtime.SetFinalizer(a, func(interface{}) {
			fmt.Println("a finalizer")
		})
		runtime.SetFinalizer(b, func(interface{}) {
			fmt.Println("b finalizer")
		})
	}

  a, b = nil, nil
	for range time.NewTicker(time.Second).C {
		fmt.Println("call runtime.GC()")
		runtime.GC()
	}
}
```

执行结果：

```shell
> go run -gcflags '-N -l' .
call runtime.GC()
call runtime.GC()
call runtime.GC()
...
```

# GC Tuner 对 Finalizer 的应用

GC Tuner 是 uber 提出的一种针对 GC 的优化手段，其原理是在每次 GC 被触发时动态调整 GOGC 的取值，从而保证内存一直维持在一个比较恒定的水位，最终达到空间换时间的效果，避免 GC 的频繁发生。在这个过程中有两个核心的操作，第一是我们需要在每次 GC 到来时都执行一段自定义逻辑，第二是这段自定义逻辑用来调整 GOGC 的取值。

经过前面的分析，不难想到这里的第一点可以用 Finalizer 技术来实现。具体来说，对一个对象设置了 Finalizer 后，当 GC 到达清扫阶段后会执行绑定的函数，函数执行结束后才会释放对象对应的内存。那么如果我们在绑定的函数中再次为这个对象设置 Finalizer，就可以保证这个对象持续存活到下一次绑定函数被执行。通过这种递归的方式，就可以确保对象一直存活，而 Finalizer 函数不断地被 GC 清扫阶段触发，而这恰好符合 GC Tuner 的目标。

但需要注意的是，其他对象绑定的 Finalizer 不能包含长耗时的操作，否则就会遇到我们前面提到过的问题，可能会有几轮 GC 脱离了 GC Tuner 的控制。

下面是一个例子，对象 a 绑定的 Finalizer 函数会因为 GC 的触发而不断被调用：

```go
package main

import (
	"fmt"
	"runtime"
	"time"
)

func main() {
	var (
		a         int
		finalFunc func(interface{})
	)
	finalFunc = func(ap interface{}) {
		fmt.Println("can u see me?")
		runtime.SetFinalizer(ap, finalFunc)
	}
	runtime.SetFinalizer(&a, finalFunc)

	for range time.NewTicker(time.Second).C {
		fmt.Println("call runtime.GC()")
		runtime.GC()
	}
}
```

执行结果：

```go
> go run -gcflags '-N -l' .
call runtime.GC()
call runtime.GC()
can u see me?
call runtime.GC()
can u see me?
call runtime.GC()
can u see me?
call runtime.GC()
can u see me?
call runtime.GC()
can u see me?
call runtime.GC()
can u see me?
...
```

