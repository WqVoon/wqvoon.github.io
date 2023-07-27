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



# 执行 Finalizer





# Finalizer 的一些问题

## 长耗时操作导致其他对象的 Finalier 无法被执行

## 循环引用导致内存泄漏



# GC Tuner 对 Finalizer 的应用

