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

golang 的 runtime 使用一个独立的协程来串行执行所有的 Finalizer，这个协程平时处于休眠状态，GC 的清除阶段如果发现有需要执行的 Finalizer，那么会设置一个标记位（runtime.fingwake），在协程调度阶段，runtime.findrunnable 函数负责确保“一定会找到一个可执行的协程”，其中就会判断这个标记位，并按需将这个负责执行 Finalizer 的协程运行在当前的 M 上。

回到 Finalizer 本身上，它是怎么和对象关联起来的呢？golang 的内存模型中，runtime.mspan 是最细粒度的内存管理单元，每个 mspan 结构管理一块内存，这块内存被划分成多个相同规格的小内存，所以被 mspan 管理的每一块小内存都有自己的 offset（相当于是小内存数组的下标）；而 mspan 这个结构体中有一个 specials 字段，这是一个 special 结构的链表，golang 中有许多 special，Finalizer 就是其中一种。special 结构中有一个 offset 字段，这个 offset 正是前面提到的某块小内存对应的 offset。总结来说，给定一个 offset，我们能从 mspan 管理的内存中找到某块小内存，也能从 specials 链表中找到对应的 Finalizer（如果有的话），而这个小内存在用户侧的表现就是一个对象，因此这个 offset 就把某个对象和 Finalizer 联系起来了。

有了这些背景知识，我们就可以一起来看一下相关的代码了。

# 设置与取消设置 Finalizer





# 执行 Finalizer





# Finalizer 的一些问题

## 长耗时操作导致其他对象的 Finalier 无法被执行

## 循环引用导致内存泄漏



# GC Tuner 对 Finalizer 的应用

