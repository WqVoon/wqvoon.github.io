---
title: 浅析 golang1.17.13 map 源码
date: 2022-12-26 22:32:34
categories:
 - [Golang]
description: 分析 map 的部分源码，包括增删改查、扩容以及 for-range 操作
---

# 前言

最近阅读了 [runtime/map.go](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go) 中的代码，以梳理 golang 中 map 这个数据结构的原理。在使用上，map 有很多内置的语法支持，但实际上这些都是 golang 提供的语法糖，这些语法在编译时都会被编译器转换为对 runtime/map.go 或其变种的函数调用，并添加一些代码，最终完成用户需要的功能。

本文尝试分析 map.go 中的代码对 map 各种操作的支持，其他变种的操作与此类似。

# 基础结构

golang 中 map 的核心结构有如下几个：

```go
// A header for a Go map.
type hmap struct {
  count     int // map 中当前有多少个元素，len() 方法读的就是这里
	flags     uint8 // 当前 map 的 flag，用于标识 map 的状态，比如是否有在写入或是遍历
	B         uint8  // loadFactor * 2^B 是当前 map 可以容纳的元素数量
	noverflow uint16 // “可能”用了多少个溢出桶
	hash0     uint32 // hash 函数的种子，引入更多的随机性

	buckets    unsafe.Pointer // 2^B 个桶，桶也就是 bmap
	oldbuckets unsafe.Pointer // 保存迁移前的桶
	nevacuate  uintptr        // 当前有多少个桶被迁移了

	extra *mapextra // optional fields
}

// mapextra holds fields that are not present on all maps.
type mapextra struct {
	// If both key and elem do not contain pointers and are inline, then we mark bucket
	// type as containing no pointers. This avoids scanning such maps.
	// However, bmap.overflow is a pointer. In order to keep overflow buckets
	// alive, we store pointers to all overflow buckets in hmap.extra.overflow and hmap.extra.oldoverflow.
	// overflow and oldoverflow are only used if key and elem do not contain pointers.
	// overflow contains overflow buckets for hmap.buckets.
	// oldoverflow contains overflow buckets for hmap.oldbuckets.
	// The indirection allows to store a pointer to the slice in hiter.
	overflow    *[]*bmap
	oldoverflow *[]*bmap

	// nextOverflow holds a pointer to a free overflow bucket.
	nextOverflow *bmap
}

// A bucket for a Go map.
type bmap struct {
	// 桶中元素的 hash 的高八位，加速查找，bucketCnt 当前取值为 8
	tophash [bucketCnt]uint8
	// 后面其实是 key*8 与 value*8，但因为编译前不知道具体类型，所以需要用指针的方式来访问
}
```

本质上讲，代码中的一个 map 变量其实是 \*hmap 类型，所以如果我们把这三个结构复制到自己的代码里，然后用下面的代码就可以访问 hmap 结构中的各个字段了：

```go
	mp := map[int]int{}
	for i := 0; i < 10; i++ {
		mp[i] = i
	}

	mpPtr := *(**hmap)(unsafe.Pointer(&mp))
	fmt.Printf("%+v\n", mpPtr)
```

# 基本原理

对于一个 map 而言，核心需求是能够根据一个 key 来增删改查对应的 value，这需要将 value 保存在槽（hash slot）里，在访问时先对 key 来进行 hash 计算，计算的结果会是一个数字，然后把这个数字对槽的数量取模，这样就可以获知 value 在哪个槽中。但槽的数量是有限的，尽管优秀的 hash 函数能够使计算结果尽可能分散到不同的槽中，当保存的 value 数量大于槽的总数时还是不可避免地会让多个 value 进入同一个槽中，对于这种名为“哈希冲突”的问题，常见的解法是“开放地址法”和“拉链法”。

golang 中的 map 采用了同样的思路，具体来说，map 中存在 2^B（B 是大于等于 0 的数字） 个 bmap 结构，这些 bmap 被放在一块连续的内存中，也就是一个数组，每个 bmap 中保存 8 个键值对。

给定一个 key，首先会通过 hash 函数来计算得到一个 uintptr 类型的值（在 64 位的系统上占 8 个字节），然后将这个值与 `2^B - 1` 做与运算，就可以得到 bmap 数组的下标。这里的与运算其实是前文取模的一种优化，因为 bmap 的数量是 2 的整数次幂，那么这个值减一就会得到一个低 B 位均为 1 的数，这时对这个数做与运算时就可以拿到 [0, 2^B) 中的一个值。

而 bmap 中首先的 8 个字节是名为 tophash 的数组，与其内部的键值对一一对应。这个值的计算方式被定义在 [tophash 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=193-200) 中，取的是 hash 函数结果的高 8 位，但由于[部分值被保留用于标识一些状态](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=88-97)，所以需要按需绕过这些值。有了这些 tophash，就可以在读取时先对比 tophash，当且仅当 bmap 中某个 tophash 的值与入参对应的 tophash 相等时再进一步比较对应的 key 与入参的 key 是否相等，这就避免了一些复杂结构的频繁判等。

而 bmap 结构本身其实并不单单是前文贴出的代码中的样子，它除了 8 个 tophash 外还包含 8 个 key、8 个对应的 value 以及一个 bmap 的指针。在运行时会为每一个 bmap 分配 `8 + 8*sizeof(key) + 8*sizeof(value) + sizeof(uintptr)` 大小的内存，从这个算式中可以发现，sizeof(key) 和 sizeof(value) 都是仅在编译时才能确定的，所以 bmap 本身的结构中仅包含 tophash，其他三个字段都是在运行时直接通过指针来访问的。为了验证这一点，我们可以为上面的 bmap 结构按实际情况填充一些字段，然后就可以用下面的代码来访问这个 bmap 中的各个值了：

```go
// ... 省略 hmap 和 mapextra 结构
type bmap struct {
  // bucketCnt 取值为 8
	tophash [bucketCnt]uint8

	// 填充具体的 keys、values 以及 ptr
	keys [bucketCnt]string
	vals [bucketCnt]string
	ptr  *bmap
}

func main() {
	mp := map[string]string{
		"hello": "world",
	}

	mpPtr := *(**hmap)(unsafe.Pointer(&mp))
	fmt.Println("len:", mpPtr.count)

	bucket := (*bmap)(mpPtr.buckets)
	fmt.Printf("%+v\n", bucket)
}

```

也就是说，bmap 中的 key 和 value 都是值类型，这也符合 golang 一贯的做法。

那么这个 ptr，就是是结尾的 bmap 指针是用来做什么的呢？这是用来链接溢出桶（overflow bucket）的。具体而言，golang 中的 map 是采用“拉链法”来解决 hash 冲突的，而这里的 ptr 是用来实现拉链的。如前所述，一个 bmap 只能保存 8 个键值对，而且这 8 个键值对 `hash(key) & (2^B - 1)` 的值是相等的（也就是当前 bmap 的下标）。那么如果此时有一个 bmap，它内部已经拥有了 8 个键值对，此时新增的第 9 个 key 算出的下标和这个已有 8 个键值对的 bmap 下标相同，就需要在这个 bmap 后面添加新的 bmap 结构才能将这个键值对保存下来。此时原有的 bmap 中的 ptr 就会指向这个新的 bmap 结构。

虽然拉链法能够在存储上解决哈希冲突的问题，但任由拉链越来越长会严重影响 map 的访问效率，极端情况下会退化成链表。会造成这个问题，本质在于 bmap 的数量会限制 hash 函数的值范围（因为会对数量减一取模），较小的值范围会让更多的 hash(key) 落在同一个桶中。所以就需要在 map 中保存的值达到一定数量时对 map 做扩容，通过增加 bmap 的数量来为 hash 函数提供更大的值范围。那么怎样确定这个数量呢？是通过 [overLoadFactor 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1070-1072) 来确定的，具体而言，当 hmap.count 大于一个 bmap 中能保存的数量时，需要判断 `hmap.count / 2^B` 是否大于 6.5，这里的 6.5 被称为负载因子（load factor），当比值大于这个值时，overLoadFactor 返回 true，此时就需要进行扩容（其实扩容的条件不止负载因子这一个，详细的内容放在下面的小节中）。

扩容的操作就是创建一个新的 bmap 数组，这个数组要在数学上更适应当前键值对的数量，然后把键值对从旧的 bmap 数组中迁移到新的数组中。不难想到，当 map 中的键值对数量很多时，这个操作会非常耗性能。所以 golang 的 map 采用了“渐进式扩容”的方式，将扩容操作分摊到每一次的写入和删除操作中，每次只迁移一部分的数据。这样解决了全量扩容带来的瞬间性能问题，但却引入了迁移中间态，也就是在某些时间点，map 有一部分数据在新的 bmap 数组，有一部分还留在旧的数组中，所以在读取时就需要兼容这一点，具体的方式在下面的内容中会讨论到。

总结而言，golang 中的 map 用 hmap 来保存多个 bmap，而具体的键值对被保存在 bmap 中，每个 bmap 对应 hash 函数的一个结果，当某个 bmap 中的键值对满了但需要在这个 bmap 中新增键值对时，会通过“拉链法”在 bmap 之后链接一个新的 bmap 结构。而为了保证 map 的访问效率，还需要适时对 map 进行渐进式的扩容。

那么下面我们就来通过源码了解一下各个操作的具体逻辑。

# 初始化

# 写入

# 读取

# 删除

# 扩容

6.5 的负载因子才能保证增量扩容只扩大一倍

# 遍历