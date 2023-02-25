---
title: 浅谈 WebAssembly
date: 2023-02-26 02:00:57
categories:
 - 前端
description: MDN 相关内容的阅读笔记与思考
---

最近阅读了 MDN 上 WebAssembly（以下简称 wasm）相关的[内容](https://developer.mozilla.org/en-US/docs/WebAssembly/Concepts)，也用 node 做了一些相关的测试，算是基本了解了 wasm 这门技术的背景与使用方法，于是写下这篇文章做一下总结。

首先要明确的是，wasm 是什么呢？看到这个名字，很多人会把它和 Web 联系在一起，但事实上 Assembly 更适合用来描述它的定位。我认为比较合适的说法是，它是一套虚拟指令集，通过配合相应的虚拟机就可以完成程序员编码出的任务。具体而言，wasm 是一种基于栈机的指令集。

这里简单解释下栈机，根据我的了解，虚拟机可以被分为栈机、累加器机和寄存器机，区分它们的一个重要方式在于读写操作数的方式。栈机在逻辑上存在一个操作栈，取数时会把操作数入栈，计算时会从栈顶取数并把结果入栈；累加器机在计算时则需要将操作数加载到累加器上，基于这个累加器做运算，然后再把结果保存到存储单元上；寄存器机则提供了很多高速的寄存器，如果操作数不多完全可以基于寄存器来做运算，我们现在使用的个人电脑就是寄存器机。

回到正题，正因为 wasm 是一套指令集，所以它可以作为各种语言的目标语言，比如 LLVM 就提供了从 LLVM-IR 到 wasm 的编译支持，这意味着只要某种语言可以被编译成 LLVM-IR，那么它就可以继续被编译成 wasm。除此之外，wasm 还定义了一种 wat 作为后缀名的文件，里面可以通过一种 S 表达式方式的语法来编写[既定的指令](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference)，这些指令可以被诸如 wabt 这样的工具编译成 wasm 的二进制文件，下面是一个简单的 wat 程序，它提供一个 add 函数用于计算两个数字的值：

```wat
(module
    (func (export "add") (param $x i32) (param $y i32) (result i32)
        local.get $x
        local.get $y
        i32.add
    )
)
```

但如果 wasm 仅仅是作为一种虚拟指令集被提出，那它的价值也许没有那么大，一个帮助 wasm 从虚拟指令集中脱颖而出的重要原因，是浏览器的 JavaScript 原生支持 wasm 的加载与执行。比如我们将上面的 wat 文件编译为 wasm 二进制，假设命名为 main.wasm，那么我们就可以使用如下的代码在 JavaScript 中使用这个函数：

```javascript
WebAssembly.instantiateStreaming(fetch("main.wasm"), {
  // 这里用来向 wasm 提供一些 JavaScript 内容
}).then(obj => {
    const ret = obj.instance.exports.add(1, 2) // 调用导出的 add 函数拿到计算结果
    console.log("get result:", ret) // 输出这个结果
}).catch(err => {
    console.error("failed to run wasm, err:", err)
})
```

现代的 Web 应用太复杂了，JavaScript 作为实现网页动态交互的核心语言，在保证了灵活性的同时却很难兼顾性能。举例来说，对于一个返回常量 1 的函数 getOne，静态语言可以直接将其内联优化，但 JavaScript 不能简单地这样做，因为它无法保证 getOne 在运行期间会被赋值成什么东西，也许是一个返回其他值的函数，或者也许都不是一个函数了。尽管这种特性在一些场景下为代码的编写带来了方便，但在另一些特定场景下，我们并不需要这种动态特性，一个重要的领域就是计算场景，在这里我们能够确定参数的类型，只是需要做大量的复杂计算，而这就是 wasm 大放异彩的地方，在这个场景下它可以提供超过 Js 的性能。

此外，由于浏览器加载的是 wasm，但它并不关注这个 wasm 是怎么得到的，这意味着我们可以用任意一种语言来编写代码，然后将它们编译成 wasm 让浏览器来执行。更有趣的是，JavaScript 可以执行 wasm 提供的函数，wasm 也可以执行 JavaScript 提供的函数。基于这两点，我们就可以做到更多有趣的事情。比如我们可以在 Js 中封装一些 DOM 操作并提供给 wasm，然后通过其他语言来使用这些函数，这样我们就有了通过各种语言操作 DOM 的能力，也就是说，网页的编写就不会只限制在传统的三剑客（HTML、CSS、JavaScript），其他语言也可以参与进来。在这个思路上已经有一些实践，比如 golang 提供了 wasm 作为编译目标，且提供了对 DOM 的封装，又比如 [vugu](https://www.vugu.org/) 这个项目，让 HTML 可以与 golang 中的结构相互配合。

除此之外，wasm 一个更广为流传的特点就是它的安全性，也就是所谓的“沙箱”。具体而言，wasm 能够访问的资源是外部可控的，在这其中首先应该被讨论的就是内存。每一个 wasm 可以拥有属于自己的一段内存，这段内存可以从外部导入，比如 JavaScript 提供了 [WebAssembly.Memory](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory) 对象供 wasm 使用，也可以由 wasm 自己主动申请，不过二者只能选一个，但不论是哪一种，当前 wasm 能够使用的最大内存大小是 4GB，你可以通过 `new WebAssembly.Memory({ initial: 1, maximum: 65537 })` 这样一条 Js 语句来验证这个问题，wasm 的内存是分页的，一页 64 KB，所以最多能够申请 65536 页，这里尝试申请 65537 页，所以它会抛出 RangeError 的异常。

此外你有可能想到，wasm 是基于栈机的，所以我们可以在里面写一个无限循环，循环体中不停地向栈中压入内容来试图触发栈溢出，但我自测时是没有问题的，比如对于下面的代码就可以一直执行下去：

```wat
(module
    (func (export "main")
        (loop $my_loop
            i32.const 10086
            br $my_loop
        )
    )
)
```

我个人猜测是因为 br 每次跳回 loop 时都会清理掉这次循环对应的逻辑栈的内容，所以 `i32.const 10086` 这个声明事实上只在逻辑栈中占用 4 个字节的位置，但我没有找到相关的官方描述。

除了内存以外，wasm 也没有能力直接访问其他系统资源，比如网络、磁盘等，除非宿主环境主动向其提供这些能力。我们知道，现代操作系统中的进程如果想要访问系统资源，是需要通过系统调用借助内核来完成的，wasm 也有类似的东西，这个东西被称为 WASI，也就是 WebAssembly System Interface。事实上，由于宿主机环境可以自由向 wasm 导入函数，所以为了访问网络、磁盘，我们完全可以封装一个函数然后提供给 wasm，WASI 的原理也是这个，但它更大的意义在于提供了一种标准，而标准和实现是分离的，标准的存在可以让各种实现能够更好地相互配合。

进程通过系统调用来通过内核访问系统资源，wasm 通过 WASI 来通过宿主环境访问系统资源，那么它们的区别在于什么呢？最核心的区别在于，宿主环境可以灵活而轻量地控制 wasm 可以使用哪些能力，以 JavaScript 为例，wasm 被加载后对应一个 [WebAssembly.Module](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Module) 对象，也即一个模块，而它被运行时需要生成一个对应的 [WebAssembly.Instance](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Instance) 对象，一份 wasm 二进制在 Js 中可以对应多个 Instance，每个 Instance 在运行时可以导入不同的 Js 函数，所以即便是同一份 wasm 二进制文件，它在运行时的表现也可能是不一样的，而它的表现完全由宿主环境来决定。

把这个特性放到应用层的代码上，当我们用高级语言导入一个外部模块时，如果不去阅读它的代码，我们不能保证这个模块会带来怎样的影响，比如它可能在启动时随机删除我们计算机上的文件，甚至通过网络下载病毒到本地并运行；但如果我们使用一个外部的 wasm，在运行时不给它提供网络访问、磁盘访问的能力，那么就可以保证它无法通过这些来危害我们的设备。

wasm 本身并不复杂，但它提供了很多有意思的特性，这些特性间的组合就能带来很多可能性。我们再举个例子，上面提到 Js 中有 WebAssembly.Memory 对象，如果将它导入给 wasm，wasm 就可以使用它对应的一段内存，这包括读和写，而 Js 也可以通过这个对象来获取里面的内容，从而达到 Js 与 wasm 交换大片数据的效果。那么如果同一个 Memory 对象被多个 wasm 使用会发生什么呢，不难想到，wasm 之间就有了交换数据的方式，因为它们共享同一块内存，基于这一点，就可以实现类似动态链接的效果。所以我们在进程中运行多个 wasm 实例，就类似于在一个操作系统中运行多个进程，正是因为这种相似性，所以有了 nano process 等概念被提出。而由于进程间的交互可以以服务的维度分隔，所以有了微服务的后端部署方式，对应到 wasm，就有了纳服务（nano service）等概念被提出。

总结而言，由于 wasm 的沙箱特性，以及它可以与各种语言交互，并可以由各种语言编译而成，所以未来一定会在很多领域发挥重要作用。