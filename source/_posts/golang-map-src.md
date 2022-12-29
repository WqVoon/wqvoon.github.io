---
title: 浅析 golang map 源码
date: 2022-12-26 22:32:34
categories:
 - [Golang]
description: 分析 1.17.13 版本 map 的部分源码，包括增删改查、for-range 以及扩容操作
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

给定一个 key，首先会通过 hash 函数来计算得到一个 uintptr 类型的值（在 64 位的系统上占 8 个字节），然后将这个值与 `2^B - 1` 做与运算，就可以得到 bmap 数组的下标。这里的与运算其实是前文取模的一种优化，因为 bmap 的数量是 2 的整数次幂，那么这个值减一就会得到一个低 B 位均为 1 的数，这时对这个数做与运算时就可以拿到 [0, 2^B) 中的一个值，而这个值的取值范围与 bmap 数组的下标范围相同。

而 bmap 中首先的 8 个字节是名为 tophash 的数组，与其内部的键值对一一对应。这个值的计算方式被定义在 [tophash 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=193-200) 中，取的是 hash 函数结果的高 8 位，但由于 [部分值被保留用于标识一些状态](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=88-97)，所以需要按需绕过这些值。有了这些 tophash，就可以在读取时先对比 tophash，当且仅当 bmap 中某个 tophash 的值与入参对应的 tophash 相等时再进一步比较对应的 key 与入参的 key 是否相等，这就避免了一些复杂结构的频繁判等。

而 bmap 结构本身其实并不单单是前文贴出的代码中的样子，它除了 8 个 tophash 外还包含 8 个 key、8 个对应的 value 以及一个 bmap 的指针。在不考虑内存对齐的情况下，golang 在运行时会为每一个 bmap 分配 `8 + 8*sizeof(key) + 8*sizeof(value) + sizeof(uintptr)` 大小的内存，从这个算式中可以发现，sizeof(key) 和 sizeof(value) 都是仅在编译时才能确定的，所以 bmap 本身的结构中仅包含 tophash，其他三个字段都是在运行时直接通过指针来访问的。为了验证这一点，我们可以为上面的 bmap 结构按实际情况填充一些字段，然后就可以用下面的代码来访问这个 bmap 中的各个值了：

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

如果运行上面的代码，就可以直接在 bucket 的 keys 和 vals 中看到 “hello” 和 “world”，但是并不是所有的 key 和 val 都可以直接放在 bmap 中，golang 在源码中定义了 [maxKeySize 和 maxElemSize](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=73-78)，当 key 或 val 的大小大于这个值时，就会只在 bmap 中保存对应的指针，这样就避免了 bmap 过大的问题。

那么这个 ptr，就是是结尾的 bmap 指针是用来做什么的呢？这是用来链接溢出桶（overflow bucket）的。具体而言，golang 中的 map 是采用“拉链法”来解决 hash 冲突的，而这里的 ptr 是用来实现拉链的。如前所述，一个 bmap 只能保存 8 个键值对，而且这 8 个键值对 `hash(key) & (2^B - 1)` 的值是相等的（也就是当前 bmap 的下标）。那么如果此时有一个 bmap，它内部已经拥有了 8 个键值对，而新增的第 9 个 key 算出的下标和这个已有 8 个键值对的 bmap 下标相同，就需要在这个 bmap 后面添加新的 bmap 结构才能将这个键值对保存下来。此时原有的 bmap 中的 ptr 就会指向这个新的 bmap 结构。

所以，hmap.buckets 其实可以看作是一个二维的 bmap 数组，第一维的下标通过哈希函数加与运算的方式来获取，而第二维则是一个链表，链表中所有 key 的 `hash(key) & (2^B - 1)` 的值都是相同的。在读写 bmap 时，首先计算出第一维的下标，然后遍历这个下标对应的链表，在链表的某个节点上做具体的增删改查。

虽然拉链法能够在存储上解决哈希冲突的问题，但任由拉链越来越长会严重影响 map 的访问效率，极端情况下会退化成一条链表（写入的所有 key 计算出的下标都相同）。而之所以会造成这个问题，本质在于 bmap 的数量会限制 hash 函数的值范围（因为会对数量取模），较小的值范围会让更多的 hash(key) 落在同一个桶中。所以就需要在 map 中保存的值达到一定数量时对 map 做扩容，通过增加 bmap 的数量来为 hash 函数提供更大的值范围。那么怎样确定这个数量呢？是通过 [overLoadFactor 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1070-1072) 来确定的，具体而言，当 hmap.count 大于一个 bmap 中能保存的数量时，需要判断 `hmap.count / 2^B` 是否大于 6.5，这里的 6.5 被称为负载因子（load factor），当比值大于这个值时，overLoadFactor 返回 true，此时就需要进行扩容（其实扩容的条件不止负载因子这一个，详细的内容放在下面的小节中）。

扩容的操作就是创建一个新的 bmap 数组，这个数组要在数学意义上更适应当前键值对的数量，然后把键值对从旧的 bmap 数组中迁移到新的数组中。不难想到，当 map 中的键值对数量很多时，这个操作会非常耗性能。所以 golang 的 map 采用了“渐进式扩容”的方式，将扩容操作分摊到每一次的写入和删除操作中，每次只迁移一部分的数据。这样解决了全量扩容带来的瞬间性能问题，但却引入了迁移中间态，也就是在某些时间点，map 有一部分数据在新的 bmap 数组，有一部分还留在旧的数组中，所以在读写时就需要兼容这一点，具体的方式在下面的内容中会讨论到。

总结而言，golang 中的 map 用 hmap 来保存多个 bmap，而具体的键值对被保存在 bmap 中，每个 bmap 对应 hash 函数的一个结果，当某个 bmap 中的键值对满了但需要在这个 bmap 中新增键值对时，会通过“拉链法”在 bmap 之后链接一个新的 bmap 结构。而为了保证 map 的访问效率，还需要适时对 map 进行渐进式的扩容。

那么下面我们就来通过源码了解一下各个操作的具体逻辑。

# 初始化

golang 中可以通过字面量或 make 方法来创建一个 map，但字面量的初始化方式会被转换为 make 与循环赋值的方式，所以最终的初始化还是由 make 来做的。另一方面，如果 map 可以分配在栈上且其容量小于 8 时，编译器会直接创建一个 hmap 的结构并为其赋初值。

当代码中使用 make 来创建 map 时，最终会调用 [runtime.makemap 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=298-336) 或其变种，我们这里仅分析 makemap 函数。由于 map 的本质是一个 hmap 的指针，所以 makemap 函数的最终目的就是创建一个 hmap 结构并按需为其填充字段。其中 hmap.hash0 通过 fastrand 函数来初始化，这个值会作为后面 hash 函数的一部分来为其引入更多的随机性。紧随其后的是对 hmap.B 的初始化，通过循环调用 [overLoadFactor 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1069-1072) 来找到一个最小能容纳 hint 个元素的 B 值，然后将其赋值给 hmap.B 字段。

根据 overLoadFactor 的定义可以得知，如果 hint 小于等于 bucketCnt（也就是 8），那么 B 就会取为 0，此时并不会创建 bmap 结构，而是等第一次赋值时才进行初始化。与之相对的，如果 hmap.B 不为 0，那么就会调用 [makeBucketArray 函数]() 来创建 bmap 数组，这个函数返回数组的首地址以及可能存在的溢出桶地址。

具体来看 makeBucketArray 函数中的逻辑，首先通过 `bucketShift(b)` 计算出 hmap.B 代表的 bmap 的数量，然后将这个值分别赋值给 base 和 nbuckets 变量，此时两个变量的值相等。然后判断 hmap.B 的值，如果大于等于 4，那么认为后面会使用溢出桶的概率比较高，此时会为 nbuckets 增加 `2^(hmap.B-4)` ，由于 nbuckets 才是最终创建的 bmap 数组的长度，所以此时创建的 bmap 的数量是大于所需数量的，多出来的这部分就作为未来会使用的溢出桶。

也就是说，最终创建的 bmap 数组中会有 nbuckets 个元素，其中前 2^B 个元素是正常的 bmap，而后 `nbuckets - 2^B` 个元素是作为溢出桶的 bmap。为了方便访问溢出桶，就需要记录一下溢出桶的位置，这也就是 makeBucketArray 函数的第二个返回值。如果 bmap 数组中存在溢出桶，那么 nbuckets 和 base 变量就不再相等，其中 base 的值就是正常 bmap 的数量，也就是 2^B。所以在 makeBucketArray 的 [最后](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=376-385) 判断了两个变量是否相等，如果不相等，那么算出第一个溢出桶的地址，将这个地址赋值给 hmap.extra 并返回给调用者。同时，会通过 [bmap.setoverflow 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=211-213) 将 bmap 中最后一个溢出桶的 ptr 指向第一个 bmap，而由于创建 bmap 数组时是申请了对应大小的内存并填充 0 在里面，所以整个 bmap 数组中除最后一个溢出桶外的所有 bmap.ptr 都是 nil，这就把最后一个溢出桶与其他的 bmap 结构区分开了，这个区分的作用留到后面的小节来讨论。

此外，我们前面提到，bmap.tophash 中有一些值被用作了保留项，可以看到 [0 对应的含义](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=92) 是“这个槽是空的且后面没有更多的数据了”，而由于 bmap 内部在初始化时所有的字节都是 0，所以就在初始化时直接达成了这个保留项的目的。

# 写入

golang 中对 map 进行写入时的代码类似于 `map[key] = val`，这个语句在编译时会被替换成对 [runtime.mapassign 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=570-683) 的调用，这个函数接收 key 的指针并返回 val 的地址，拿到地址后通过编译器加入的赋值语句完成对 map 中字段的赋值。

首先，golang 中的 map 是不支持并发读写的，这一点在代码里也做了一定的保证，具体来说，[hmap.flags 字段中的各个位记录了 map 的各种状态](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=99-103)，其中右边数第三位被称为 hashWriting，在写入和删除操作中会通过异或的方式 [设置这个标记位](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=589-591)，并在结束后 [取消这个标记位](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=675-678)。如果在写入和读取时发现这个标记位已经被设置，那么就会直接 panic。为了复现这一点也很简单，只要创建两个 goroutine 对同一个 map 做读写即可。

然后，mapassign 函数会通过 hasher 函数计算入参的 key 对应的哈希值，如前所述，这个值是 uintptr 类型。

紧接着是判断 hmap.buckets 字段是否为 nil，在前面讨论 makemap 的逻辑中曾提到，如果创建时传递的大小不超过 bucketCnt，那么 hmap.B 的值为 0，此时并不会创建 hmap.buckets 结构，直到第一次对其赋值，也就是调用 mapassign 时才会做延迟创建，从 mapassign 的代码中也印证了这一点。

如果不考虑扩容的逻辑，那么 mapassign 的核心逻辑其实和前面讨论基本原理时提到的一样，会用 hash 函数结果的低位作为 bmap 的下标，高八位作为 tophash 来查找 bmap，如果一个 bmap 中找不到且有溢出桶，那么到溢出桶里继续寻找，如果找不到，那么就是新增的 key，此时要在 bmap 中新增一个键值对并增加 hmap.count 结构，如果能找到，那么就是要修改的 key，此时返回对应的 value 的地址，然后由编译器插入的语句来完成值的更新。这样看来，键值对在 bmap 中是顺序写入的，所以如果在读取时遇到了 emptyRest，也就是 0 这个特殊值，那么就可以认为这个 bmap 之后不会有数据了，此时就可以直接停止遍历。

遍历溢出桶的方式很简单，其实和遍历链表的逻辑相同，只要一直找到 hmap.ptr 为 nil 即可。但新增溢出桶则麻烦一些，如果当前 bmap 链表已经满了，但是需要在这个链表中增加新的键值对时，就需要分配一个新的溢出桶并放在链表的尾部，在代码中这是通过 [hmap.newoverflow 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=245-271) 来 [实现](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=652-658) 的。

这个函数会判断 hmap.extra 是否为 nil，前面分析 map 初始化时我们曾讨论过，如果提前分配了溢出桶，那么这个字段就不会为 nil，此时判断 hmap.extra.nextOverflow 字段，这个值会作为指针指向下一个可用的溢出桶，如果这个值不为 nil，那么其指向的 bmap 就可以直接返回给调用者，否则说明没有更多的溢出桶，需要新申请一块内存并返回。

当有可用的溢出桶时，还要进一步判断 `hmap.extra.nextOverflow.overflow()` 是否为 nil，前面讨论 map 初始化时我们提到过，最后一个溢出桶的这个值不是 nil，所以如果这个 overflow 函数返回了非 nil，那么就说明当前调用返回的 bmap 就是最后一个溢出桶了。

几经曲折拿到一个可用的 bmap 结构后，需要调用 [hmap.incrnoverflow 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=219-243) 来增加 hmap.noverflow，从代码中可以发现这个增加并非是准确的，当 hmap.B >= 16 时会采样自增，但是这没有什么问题，因为这个值其实只用来判断是否需要扩容，而采样自增还是全量自增对这个判断的影响不大。

在 newoverflow 函数的最后，这个新获得的 bmap 会被链接在入参的 bmap 之后，这个入参是当前 bmap 链表的最后一个元素，经过这个链接后，新获取的 bmap 会取而代之成为最后一个元素。

# 读取

golang 中对 map 的读取有两种方式，分别是 `val := map[key] ` 和 `val, ok := map[key]`，其中后者除了返回 val 或零值外还会返回一个 bool 值用于标识 map 内部是否存在这个 key。这两种访问方式会被编译器分别转换为对 [runtime.mapaccess1 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=389-450) 与 [runtime.mapaccess2 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=452-508) 的调用，粗略扫一下这两个函数的代码可以发现，它们的结构其实是相同的，不同点在于后者会返回 bool 值表示 key 是否存在，不清楚为什么 mapaccess1 没有通过直接调用 mapaccess2 来实现。

这里仅分析 mapaccess2 的代码，首先判断 hmap.count 是否为 0，如果为 0，那么不需要计算 hash 也不需要遍历 bmap 就可以知道内部一定不存在 key。而如果 hmap.count 不为 0，则继续判断 hmap.flags 的 hashWriting 标记位是否被设置过，正如前面讨论写入时曾提到过，如果这个标记位被设置，那么当前 map 正在被某个 goroutine 进行写操作。回过来，如果 hashWriting 被设置了，那么直接 panic 退出。

后面的逻辑与写入时的 mapassign 差不多，先根据 hash 函数结果的低位判断 bmap 的下标，然后用高八位做 tophash，遍历该下标下的 bmap 链表，遍历的过程中先比较 tophash，如果相等则进一步判断 key 是否相等，当 key 也相等时就取出对应 value 的地址并返回。此外，前面讨论 map 的写入时我们曾提到，键值对在 bmap 中是顺序写入的，所以如果在读取中 [遇到了 emptyRest](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=489-491)，那么就可以直接停止遍历，直接返回没有这个键值对。

# 删除

golang 中从 map 中删除某个 key 的方式是 `delete(map, key)`，这个函数不会返回任何内容，如果被删除的 key 不在对应的 map 里也不会有什么问题。在实现上，delete 函数会被编译器转换为对 [runtime.mapdelete 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=685-796) 的调用，从函数的签名上也可以看到，该函数不会返回任何内容，这与 delete 的行为一致。

mapdelete 首先会判断 hmap.count 字段，如果其为 0，那么直接退出流程，因为此时不会有任何 key 会被删除。然后，mapdelete 会判断 hmap.flags 的 hashWriting 标记位，因为删除也是一种写操作。再之后的流程就和写入与读取相同，遍历 hmap.buckets 中的 bmap 结构尝试找到待删除的键值对，如果找到则将对应的 key 和 value 的内存清零，然后将对应的 tophash 设置为 emptyOne，这个标记与 emptyRest 不同，它仅仅表示当前的 tophash 以及对应的键值对是可以写入的，而 emptyRest 同时还表示这个 tophash 及之后都没有键值对了。

如果一个键值对被删除，那么它的 tophash 会被设置为 emptyOne，但如果被删除的是最后一个键值对，即在这个键值对之后没有其他的数据了，那么就需要将它的 tophash 设置为 emptyRest，这个值的含义在上面已经讨论过了。而一旦有 tophash 被设置为 emptyRest，就需要进一步判断相邻的前一个 tophash 是否是 emptyOne，如果有则将前面的相邻的所有 emptyOne 都设置为 emptyRest。mapdelete 中用一个 [for 循环](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=763-780) 来做这件事，它不断地向前处理 emptyOne，当前 bmap 处理结束后就去处理链表中的前一个 bmap，直到没有 emptyOne。这样才能维持 emptyRest 的语义，保证读写时的效率。

处理完 tophash 后，就需要将 hmap.count 减小一位，然后在 map 中没有元素，即 hmap.count 为 0 时重置 hmap.hash0，使下一次的同一个 key 算出来的 hash 和上次不同，进一步提高了 map 的随机性。最后，mapdelete 再次判断 hmap.flags 的 hashWriting，如果没有并发读写问题，就将其清零。

通读 mapdelete 后我们可以发现，它并没有 bmap 的清理逻辑，即便一个溢出桶中所有的 tophash 都是 emptyRest，这个 bmap 也不会被清理掉。虽然这使得 bmap 链表的长度没有随着删除而减少，但这其实并不怎么影响读写的效率，因为 emptyRest 可以让 bmap 链表的遍历提前终止，而 mapdelete 维护了 emptyRest 的语义。另一方面，不清理 bmap 使得后续再写入溢出桶时不需要再分配新的内存，这进一步提高了写操作的效率。但过长的 bmap 链表是内存不友好的，所以 map 引入了新的机制来保证溢出桶的数量不会太多，这个机制就是扩容操作，我们在后面的小节会进行讨论。

# 遍历

这里的遍历指的就是 for-range 操作，具体来说，是 `for key, val := range map`、 `for key := range map`以及 `for range map`。这些操作会被编译器展开为类似如下的代码：

```go
hit := hiter{}
mapiterinit(maptype, hmap, &hit)
for ; hit.key != nil; mapiternext(&hit) {
    key := *hit.key
    val := *hit.val
}
```

上面代码中 for 循环内部的 key 和 val 是与 for-range 等式左边的变量一一对应的，所以如果只有 key 的话那么 for 循环内部也只有 key，没有变量时情况与此类似。

继续分析上面生成的代码，核心在于 hiter 类型以及 [mapiterinit 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=798-849) 与 [mapiternext 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=851-975)，先看一下 hiter 类型的定义，这里给出各个字段的注释，在两个功能函数中会用到它们：

```go
type hiter struct {
	key         unsafe.Pointer // 本次循环中获取到的 key，如果为 nil 那么结束遍历
	elem        unsafe.Pointer // 本次循环中获取到的 val，如果为 nil 那么结束遍历
	t           *maptype // 内部有当前 map 的类型信息，由于 mapiternext 没有像 mapiterinit 一样接收这个参数，所以需要将它保存到 hiter 中直接被 mapiternext 使用
	h           *hmap // 被遍历的 map，保存在这里的作用同 t 字段
	buckets     unsafe.Pointer // 调用 mapiterinit 时的 hmap.buckets
	bptr        *bmap          // 调用 mapiternext 时需要被遍历的 bmap，包括溢出桶
	overflow    *[]*bmap       // 调用 mapiterinit 时的 hmap.extra.overflow
	oldoverflow *[]*bmap       // 调用 mapiterinit 时的 hmap.extra.oldoverflow
	startBucket uintptr        // 被选为第一个遍历的 bmap，是一个下标
	offset      uint8          // 遍历 bmap 时从第几个键值对开始
	wrapped     bool           // 是否已经遍历了一圈，当遍历的 bmap 回到 startBucket 时，如果 wrapped 为 true 那么结束遍历
	B           uint8 // 调用 mapiterinit 时的 hmap.B
	i           uint8 // 调用 mapiternext 时需要被遍历的 bmap 中键值对的下标，会与 offset 字段配合
	bucket      uintptr // 调用 mapiternext 时需要被遍历的下一个 bmap 链表的下标
	checkBucket uintptr // 与扩容有关
}
```

然后继续看上面的 for 循环，为了保证第一次循环时 hit 中已经有 key 和 val 了，可以猜测 mapiterinit 内部或者直接对 key 和 val 进行了赋值，或者调用了 mapiterinit，从代码中可以看到是 [后者](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=848)。下面就一一分析一下这两个函数。

首先来看 mapiterinit，在函数的开始判断了 hmap.count 是否为 0，如果为 0 那么直接 return，此时 hiter 的 key 和 elem 字段都是 nil，回到上面被编译器生成的代码中，可以发现如果 key 为 nil，那么整个 for-range 就会结束。

然后，mapiterinit 会根据入参来填充 hiter 中的各个字段，其中 startBucket 和 offset 是随机选择的，这两个字段用于指引 mapiternext 从哪里开始遍历键值对，正是因为在这里引入了随机性，所以每次遍历同一个 map 得到的键值对顺序都可能是不同的。反过来说，如果把 startBucket 和 offset 都设置成 0，然后构建一个长度为 8 的 map，那么每次遍历拿到的键值对序列都会相同。

在 mapiterinit 的最后会给 hmap.flags 设置 iterator 和 oldIterator 两个标记位，然后进一步调用 mapiternext，尝试填充 key 和 elem 两个字段，第一次调用 mapiternext 时，一定会拿到一对不为 nil 的键值对。

map 的 for-range 也被认为是一种读操作，所以 mapiternext 的一开始就判断了 hmap.flags 的 hashWriting 标记位，如果这个标记位被设置过，那么表示存在并发读写，此时会直接 panic。然后 mapiternext 就开始遍历这个 map，每次找到一个键值对后就将上下文保存在 hiter 中方便下一次 mapiternext 被调用时来使用这些信息，然后将这次找到的键值对赋值到 hiter 上，这样编译器生成的代码就可以直接从 hiter.key 和 hiter.elem 中获取所需的内容。

在遍历的过程中，hiter.bptr 记录了正在遍历的 bmap，这个 bmap 从第 hiter.offset 个键值对开始，检查所有的键值对后判断是否有溢出桶，如果有的话将 hiter.bptr 指向溢出桶，那么下次调用 mapiternext 时就会从新的 bmap 中遍历返回键值对，新的 bmap 也是从第 hiter.offset 个键值对开始的。在 mapiternext 中不能通过检查 tophash 是否为 emptyRest 来决定是否直接结束遍历，因为 hiter.offset 很可能使最开始遍历的 tophash 不是第一个，所以即便遇到了 emptyRest，也要至少把当前这个 bmap 遍历完才可以。

而 hiter.wrapped 则记录了 bmap 数组中的最后一个 bmap 是否被遍历过，所以如果当前需要遍历的 bmap 数组的下标是 hiter.startBucket，并且 hiter.wrapped 为 true 的话，那么就可以判断所有的键值对都被遍历过，此时直接将 hiter.key 和 hiter.elem 赋值为 nil，这样编译器生成的代码就会命中 for 循环的结束条件，从而结束整个循环过程。

虽然 for-range 的过程结束了，但不论是 mapiterinit 还是 mapiternext 都没有清理 hmap.flags 中的 iterator 和 oldIterator 标记位，事实上，这两个标记的清理是在扩容阶段做的。

# 扩容

扩容的目的有两个，第一是在保存的键值对数量大于一定量时，哈希冲突的问题会变得频繁，此时需要增加 bmap 的数量来扩大哈希函数的取值范围；第二是当溢出桶太多时，需要重新设置键值对在 bmap 中的布局，让它们排列得更紧凑，这样一方面减少溢出桶的数量从二降低内存压力，一方面能加速遍历 bmap 链表，因为 emptyOne 在重排列后会消失。这两个扩容策略分别对应代码中的 [overLoadFactor 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1069-1072) 和 [tooManyOverflowBuckets 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1074-1087)。

正如前面在基本原理中讨论的，map 的扩容是渐进式的，会被分摊到各次的写操作中，且因为引入了“扩容中”的状态，所以读操作也要对它做一些兼容。

扩容操作的触发点在 [mapassign 函数中](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=645-650)，如前所述，就是对 map 进行赋值时，更具体来说是向 map 中增加新的键值对时。[hmap.growing 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1089-1092) 是一个谓词函数，通过判断 hmap.oldbuckets 是否为 nil 来获知当前的 map 是否在扩容中，如果没有在扩容，且新增一个 key 后不满足负载因子的条件或有太多的溢出桶，那么就会调用 [hashGrow 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1026-1067) 进行扩容，扩容后会用 `goto again` 重新执行 mapassign 的逻辑。下面我们就一起来看下 hashGrow 这个函数的代码，然后再看看执行过这个函数后 mapassign 的流程会有什么不同。

hashGrow 首先区分了扩容的触发原因，如果是因为有太多的溢出桶，那么会分配与原来长度相同的新的 bmap 数组，并设置 hmap.flags 的 sameSizeGrow 标记位，否则会创建原来两倍大小的 bmap 数组。然后判断 hmap.flags 是否设置过 iterator 标记位，这个标记是在 for-range 的 mapiterinit 函数中设置的，如果设置过，那么清除 iterator，只保留 oldIterator。在这之后，将新的状态更新到 hmap 中，包括新的 B、新的 flags ，更重要的，旧的 bmap 数组会被赋值给 hmap.oldbuckets 中，而 hmap.buckets 会保存新申请的 bmap 数组，虽然此时所有的键值对都在旧数组中。

hashGrow 函数执行后，hmap 结构上就有了两个 bmap 数组，在数据迁移完成之前，此时的 map 是处于“扩容中”的状态的，这使得对该 map 的读写都要有一些兼容的地方。首先来看 mapassign 函数，hashGrow 被调用后会重新执行 mapassign 的逻辑，因为 mapassign 只有新增键值对时才会触发扩容，而 hashGrow 调用后新的 bmap 数组中没有任何数据，此时如果向其中写入新的键值对，那么会对迁移操作造成影响。

那么 mapassign 在当前 map 处于“扩容中”时会做什么呢？答案是 [调用growWork 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=599-601)。在调用时传递了当前的 hmap 结构以及 mapassign 要写入的 bmap 的下标，这个函数的逻辑非常简单，首先用入参的下标计算对应的扩容前的下标，然后用这个计算的下标调用了一次 [evacuate 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1137-1249)，然后如果当前 map 仍在扩容中，那么用 hmap.nevacuate 再调用一次 evacuate。之所以要再判断一下是否在扩容，是因为很可能第一次的 evacuate 就完成了整个 map 的扩容。

evacuate 的代码虽然比较长，但是核心逻辑也很简单，如果传递的下标对应的 bmap 链表还没有迁移，那么执行迁移，否则跳过这部分逻辑。每次调用 evacuate 时如果要迁移，那么会将入参下标对应的整个 bmap 链表迁移完，执行迁移时会区分当前是否为 sameSizeGrow，如果是的话那么直接将旧链表中所有有效的数据迁移到新链表中，然后将旧链表中的 tophash 设置为 evacuatedEmpty 或 evacuatedX；如果不是 sameSizeGrow，那么说明新的 bmap 数组的长度是旧数组的两倍，此时在迁移键值对时会计算 `hash(key) & 2^hmap.B` 的值，由于 hmap.B 已经增加了一，那么这个与运算得到的结果会比原来的结果多一个最高位，如果这一位为 1，那么将这个键值对到 `下标 + 2^(hmap.B-1)` 的 bmap 链表并设置 tophash 为 evacuatedY，否则迁移到下标对应的 bmap 链表并设置 tophash 为 evacuatedX。

在 evacuate 的最后，会判断入参的下标是否与 hmap.nevacuate 相等，如果相等那么调用 [advanceEvacuationMark 函数](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=1251-1273)，这个函数的主要作用在于调整 hmap.nevacuate 的状态以及判断扩容是否完成。对于 hmap.nevacuate 的更新，由于 hashGrow 内部调用了两次 evacuate，第一次传递的下标是随机的，所以 hmap.nevacuate 之后可能有很多 bmap 链表已经完成迁移了，advanceEvacuationMark 每次最多会检查 1024 个链表，也就是说 hmap.nevacuate 每次最多增加 1024，实际迁移的链表数量是可能大于这个值的。而一旦 hmap.nevacuate 的值与旧 map 的长度相等，那么说明这个 map 的所有键值对都完成迁移，此时将 hmap.oldbuckets 设置为 nil，让 hmap.growing 返回 false。

以上就是 map 扩容的逻辑，现在回过头来看下读写操作对扩容的兼容。首先是 mapassign，如前所述，当决定了要写入的 bmap 链表的下标时，如果当前 map 在扩容，那么会用这个下标调用 growWork 来完成对应的旧链表的迁移。growWork 结束后，新的链表中就有了迁移后的紧凑的数据，自此 map 的扩容不会再对这个链表造成影响，所以对这个链表正常执行 mapassign 的逻辑即可。

与 mapassign 类似，mapdelete 作为另一种写操作，也会按需调用 growWork 来完成待删除键值对所在 bmap 链表的迁移，调用后也只需要正常对新链表执行 mapdelete 的逻辑，因为此后 map 的扩容不会再对这个链表造成影响。

和写操作不同，读操作并不会按需执行 growWork，所以它们对扩容的支持相对麻烦一些，首先来看 mapaccess2（mapaccess1 的逻辑与此相同，这里不在赘述），这个函数读取了 [hmap.oldbuckets 是否为 nil](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=474-483)，如果不为 nil，那么就说明当前 map 处于扩容中（与 hmap.gorwing 是一个道理），此时从 oldbuckets 中获取 hash 对应的旧的 bmap 结构，然后判断这个 bmap 是否完成迁移，如果没有完成，那么就把这个 bmap 赋值给 b 变量，此后的读逻辑就会到这个 bmap 对应的链表中查找所需的 key。

另一个读操作是 map 的遍历，具体的逻辑在 mapiternext 函数中。由于“在遍历 map 的过程中向其写入新的键值对”这个行为是不确定的，而 hmap 的扩容只会发生在 mapassign 新增键值对时，所以如果要考虑 for-range 与扩容的关系，那么正常情况下只会有 map 处于扩容中的时候对其进行 for-range，而不会有 for-range 的过程中开始扩容。对于这种情况，mapiternext 的处理与 mapaccess2 类似，如果当前遍历的 bmap 链表没有完成迁移，那么去遍历迁移前的 bmap 链表，如果已经完成迁移，那么直接遍历新的 bmap 链表。

但由于 for-range 最终会遍历整个 map，所以如果在非 sameSizeGrow 的情况下单纯用这种方式是会有问题的，因为比如扩容前有 2 个 bmap 链表，扩容后有 4 个，那么 0 和 3 都对应原来的 0 号链表，而遍历后会分别扫过 0 和 3，如果判断原来的 0 没有做迁移，那么就会遍历两次 0 号链表，最终的结果就是部分键值对会出现两次。所以，mapiternext 在遍历时以新的 bmap 数组为准，假设当前遍历的新 bmap 链表为 a，那么如果对应的旧 bmap 链表还没有迁移，就会去遍历旧链表，然后 [只返回那些迁移时会被移动到 a 中的键值对](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=911-924)，下次遍历这个旧链表时再返回剩余的部分。

另外，和新增键值对不同，修改已有的键或删除某个键是被允许的，而这虽然不会引起扩容，但是会导致迁移。也就是说，有可能两次连续调用 mapiternext 来从同一个 bmap 结构中获取两个键值对，然后在调用之间修改了 map 中的键对应的值，或是直接删除了某个键，那么很可能在第一次调用时这个 bmap 还是未迁移的状态，而第二次调用时却是已经迁移的状态了。要解决这个这个问题也很简单，因为一旦某个 bmap 被迁移，那么它的 tophash 会是 evacuatedX 或 evacuatedY，此时只需要在遍历到这种键值对时 [特殊处理](https://cs.opensource.google/go/go/+/refs/tags/go1.17.13:src/runtime/map.go;l=949-963) 即可。