---
title: 浅析 bytedance/mockey 源码
date: 2023-1-26 22:32:34
categories:
 - [Golang]
description: 分析 v1.1.1 版本 mockey 的部分源码，包括变量 patch 与函数 patch
---

# 前言

monkey patch 是一种在运行时动态修改函数或变量内容的功能，被广泛用在单元测试中。比如一个功能函数需要调用一次 rpc 拿到数据，然后对响应体做一些计算处理后再返回最终结果，那么为了测试这个功能函数的计算逻辑，就可以通过 monkey patch 来修改掉 rpc 的部分，按需返回不同的响应，从而灵活地进行各种 case 的测试。通常而言，动态修改函数内容是动态语言提供的福利，但借助一些特殊手段，静态语言也可以实现同样的效果。本文以字节跳动开源的 [v1.1.1 版本 mockey 库](https://github.com/bytedance/mockey/tree/v1.1.1)为例，通过分析源码的方式来学习 golang 中实现 monkey patch 的方法。

mockey 对外提供的核心功能有两点，一个是运行时修改变量，一个是运行时修改函数，下面会分别对这两种能力进行分析。

# 修改变量

这个功能感觉上有点云里雾里，因为变量其实就是可以手动修改的。mockey 在常规修改上包装了一层，通过反射来实现各种变量的 patch 和 unpatch，并在这个过程中通过加锁保证同一个 mock 结构的并发安全。

修改变量的功能主要通过 [MockerVar 结构](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L34-L43) 来实现，这个结构与一个要被修改的变量一一对应，为了保证修改的并发安全，最好能做到唯一对应。使用者可以通过 [MockValue 函数](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L45-L54) 来得到这个变量，后续的操作都通过这个变量来完成。MockValue 的实现非常简单，首先断言入参是否为指针，如果不是指针就进行 panic，这个断言直接通过判断 `reflect.TypeOf(ptr).Kind() == reflect.Ptr` 的结果来实现。不过 v1.1.1 版本的 [AssertPtr 和后面会用到的 AssertFunc](https://github.com/bytedance/mockey/blob/v1.1.1/internal/tool/assert.go#L39-L45) 都有点小问题——格式化字符串后面没有带具体的变量，不过这无伤大雅。MockValue 的断言通过后，就会返回一个 MockerVar 结构，其内部已经保存了变量的原始值与类型等信息。

用户想要 patch 的变量值通过 [MockerVar.To](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L55-L69) 方法来提供，这个方法首先判断入参是否为 nil（这里的判断直接通过双等来做，其实由于那个著名的 interface{} 与 nil 的问题，这里的 nil 判断并不准确），如果为 nil，那么就用 `reflect.Zero(mocker.targetType)` 来构建一个零值，并用这个值来 patch 对应的变量，否则通过 `reflect.ValueOf(value)` 使用用户提供的值，这个值会被放入 MockerVar.hook 字段中。为了确保 hook 中的值是能够赋值给 MockerVar.target，也就是目标变量的，To 方法断言了 `v.AssignableTo(mocker.targetType)`，这个 v 取的是 hook 的类型，如果这个断言能通过，那么后面给 target 赋值时就不会发生 panic。

做完了前置的判断，MockerVar.To 就会直接调用 [MockerVar.Patch](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L71-L84) 方法，这个方法通过加锁的方式来判断 MockerVar.isPatched 变量，如果其为 false，那么说明当前的目标变量没有被 patch 过，此时会用 `mocker.target.Set(mocker.hook)` 来实现变量的赋值，然后调用 [addToGlobal 函数](https://github.com/bytedance/mockey/blob/v1.1.1/convey.go#L51-L58) ，这个函数会先判断当前 MockerVar 的 key 是否在一个全局的 map 中，如果已经存在了，那么说明某个变量对应了两个 MockerVar 结构，此时会因为断言而结束程序的执行。因为这个 key 实际上 [是被 patch 的变量的地址](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L102-L104) ，所以能够保证与对应变量的一一对应关系，从而也就基本保证了 patch 操作的全局可控。这里说“基本保证”，是因为这个全局 map 的读写没有加锁，所以这个保证也不够彻底。

所以，MockerVar.To 被调用后，整个变量的 patch 操作就结束了，此时变量的值已经被修改为 To 函数的入参，To 函数将 MockerVar 返回，用户可以通过这个结构调用 [MockerVar.Unpatch](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L86-L100) 方法做变量的 unpatch，在这个操作被触发之前，该变量 [没有办法再次进行 patch](https://github.com/bytedance/mockey/blob/v1.1.1/mock_var.go#L72-L75)。Unpatch 方法其实就是 Patch 方法的逆操作，也就是通过 `mocker.target.Set` 来完成 target 的恢复，通常来讲这个值被保存在 origin 中，然后再调用 removeFromGlobal 将当前 MockerVar 结构从全局 map 中移除，这样就可以再次进行 path，这可以通过当前 MockerVar 来实现，也可以新建一个 MockerVar 来做这件事情。

# 修改函数

相较于修改变量，修改函数就变得比较复杂了，在继续阅读前，我强烈推荐读者阅读一下 [这篇文章](https://bou.ke/blog/monkey-patching-in-go/)，这是 [monkey](https://github.com/bouk/monkey) 这个库的作者在其博客中描述的运行时修改函数的实现原理，讲得非常通俗易懂。mockey 的思路基本与此类似，不过它在这之上提供了更多额外的功能。

修改函数的功能主要通过 [Mocker](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L35-L47) 结构来实现，可以看到相较于 MockerVar 结构，这里多了很多字段。为了产生这个结构，需要通过 [MockBuilder](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L49-L59) 结构来完成内部字段的初始化，具体而言，[Mock](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L61-L67) 函数会得到最初的 MockBuilder，然后用户可以通过这个结构的各种方法来完成其他字段的赋值，这些方法会继续返回当前的 MockBuilder 结构，所以可以通过一种链式的调用来达成初始化的目的，这个链式调用最终会以 [MockBuilder.Build](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L153-L158) 方法为终结，当这个方法被调用时，整个 patch 就开始生效了。

正因为如此，Mock 函数本身非常简单，它仅仅接受 target 函数，也就是需要被 patch 的函数作为参数，在内部通过 `tool.AssertFunc(target)` 来断言这个入参是否为函数，然后将其赋值给 MockBuilder.target 后就返回了。

有了 target 函数，还需要一个 hook 函数，这个函数就是 target 被 patch 后会执行的东西。MockBuilder 提供了两个方法来设置 hook 函数，分别是 [MockBuilder.To](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L112-L115) 和 [MockBuilder.Return](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L117-L120)，这两个函数都在一开始断言了 hook 字段是否为 nil，因为如果不为 nil，那么就说明当前的 MockBuilder 是被二次利用的，这样就会出现问题。具体而言，同修改变量一样，mockey 希望每个 Mocker 结构能唯一对应一个 target 函数，而 MockBuilder.Build 方法每次都会返回一个新的 Mocker 结构，复用 MockBuilder 意味着会有两次 Build 方法的调用，此时就产生了两个 Mocker。正确的方法应该是复用第一次 Build 产生的 Mocker，因为它完全有能力完成 repatch 等操作。

回过来继续看 hook 的赋值，首先来看 MockBuilder.Return，它实际上是 [MockBuilder.setReturn](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L136-L151) 方法的包装方法，语义上代表在 patch 阶段让 target 函数固定返回 MockBuilder.Return 的入参。这个方法首先调用 [tool.CheckReturnType](https://github.com/bytedance/mockey/blob/v1.1.1/internal/tool/check.go#L23-L33) 这个工具函数来判断入参是否和 target 函数的返回值类型相匹配，比如 target 的签名是 `func() (int, int, int)`，入参就必须是三个数字才行。CheckReturnType 首先判断  target 是否为函数类型，然后判断 target 的返回值数量是否与入参的数量相等，这些都通过后，CheckReturnType 会依次遍历 target 的各个返回值类型，通过 `reflect.TypeOf(results[i]).ConvertibleTo(t.Out(i))` 来判断入参与返回值类型是否匹配。这里调用了 ConvertibleTo，就意味着 MockBuilder.setReturn 的入参与 target 的返回值的类型并不需要完全相同，比如 `reflect.TypeOf(1).ConvertibleTo(reflect.TypeOf(1.0))` 也是成立的。当类型判断通过后，MockBuilder.setReturn 方法调用 `reflect.MakeFunc` 创建一个返回固定值的函数，然后将其赋值给 hook 字段。

不同于 MockBuilder.Return，MockBuilder.To 方法要更加简单些，它接受一个函数作为参数，这个函数的签名需要等同于 target 的签名，代表在 patch 阶段使用这个函数来替换 target。这个函数包装了 [MockBuilder.setTo](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L105-L110)，而 setTo 并没有做太多的事情，它仅仅简单判断了入参的类型是函数类型，然后就将其赋值给了 hook 字段，并没有做函数签名的判等。

有了 target 和 hook，就可以通过 [MockBuilder.Build](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L153-L158) 方法来做 patch 了，这个方法简单初始化了 Mocker 结构，然后依次调用 Mocker.buildHook 和 Mocker.Patch，再将这个 Mocker 返回。因为 Mocker.Patch 就是 patch 生效的地方，所以到此为止 MockBuilder 的使命就结束了，用户后面需要通过 Build 方法返回的 Mocker 来完成同一个函数下一次的 repatch。

让我们先跳过 [Mocker.buildHook](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L175-L235) 这个方法，暂且将其理解为将 MockBuilder 中的一些字段赋值给 Mocker，从而进一步完成 Mocker 的初始化即可，对这个函数的详细分析放到后面来进行，现在先把目光聚焦在 [Mocker.Patch](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L237-L249) 上。它在整体上有着与 MockerVar 差不多的逻辑，首先通过加锁判断 Mocker.isPatched 是否为 true，如果条件成立那么说明这个 Mocker 已经做过 patch，此时直接返回，避免重复对同一个函数做多次 patch 导致混乱。如果没有 patch 过，那么会调用 [monkey.PatchValue](https://github.com/bytedance/mockey/blob/v1.1.1/internal/monkey/patch.go#L42-L74) 这个工具函数，这个函数会完成函数的 patch 过程，并返回一个 [Patch](https://github.com/bytedance/mockey/blob/v1.1.1/internal/monkey/patch.go#L29-L34) 结构，在这之后，Mocker.Patch 通用调用 addToGlobal 工具函数，与 MockerVar 结构类似，每个 Mocker 也有一个 key，取值为 target 函数的地址。

继续深入到 monkey.PatchValue 这个函数，它首先通过各种断言确保了 target、hook、proxy 的类型是正确的（这里的 proxy 是一个签名与 hook 和 target 相同的函数的指针，它可以是 nil，因为它的函数内容是被人为构造的），只要类型检查通过，函数在执行时就不会出现问题。在这之后，它通过 [common.BytesOf](https://github.com/bytedance/mockey/blob/v1.1.1/internal/monkey/common/transform.go#L36-L42) 工具函数取出了 target 函数的前 bufSize 字节的内容，具体而言是 64 字节，并以 `[]byte` 的方式返回。然后，PatchValue 使用 `inst.BranchInto(common.PtrAt(hook))` 生成一段跳转到 hook 函数的二进制指令，记为 hookCode，这段指令与平台相关，在我的环境会跳转到 `internel/monkey/inst/inst_amd64.go` 这个文件中的实现上。在这之后，调用 [inst.Disassemble](https://github.com/bytedance/mockey/blob/v1.1.1/internal/monkey/inst/disasm_amd64.go#L24-L37) 在 target 函数的二进制指令中中找到一个位置，这个位置是某条指令的开始，被称为 cuttingIdx，取值要保证 `[target, target+cuttingIdx]` 这个区间能够容纳 hookCode 的完整指令。然后，它通过 common.AllocatePage 分配一个内存页，并在后面保证这个内存页是可读可执行的，这个内存页中保存了 `[target, target+cuttingIdx]` 这个区间的指令，以及跳转到 target+cuttingIdx 这个位置的指令，这个内存页会被赋值给 proxy。最后，通过 `mem.WriteWithSTW(targetAddr, hookCode)` 将 hookCode 覆写到 target 函数中，这里面会涉及到 Mprotect 这个系统调用的使用，因为 target 函数所在的内存原本是不可写的。

这一段写得有点绕，总结下来 monkey.PatchValue 其实产生了两个新的函数，分别是经过修改后的 target 以及一个新生成的 proxy。target 函数最开始的代码被替换成了“跳转到 hook 函数并执行”，所以当用户在 patch 后调用 target 时，会直接跳转到 hook，执行新的函数，这样就完成了原函数的替换。而 proxy 的前半段保存了 target 被覆写的代码，在其之后是“跳转到 target 函数未被覆写的部分并执行”，所以当用户执行 proxy 时，实际上相当于完整执行了一遍原来的 target。monkey.PatchValue 返回了一个 Patch 结构，内部保存了 target 的地址、proxy 的代码以及 cuttingIdx，当用户调用 Patch.Unpatch 时，Patch 会将 proxy 代码中的前 cuttingIdx 写回 target，这样 target 就恢复如初了。

proxy 的作用并不仅仅是用于恢复 target，否则根本没有必要分配一个可执行的内存页来构建一个函数，直接把 target 被覆盖前的那部分代码保存下来即可。之所以费尽心思，是因为 mockey 需要能够在 patch 生效的时期执行原来的 target，至少在效果上要保证一致，而 proxy 就能够做到这点。

具体而言，mockey 可以让 patch 按条件生效，MockBuilder 提供了 When、IncludeCurrentGoRoutine、ExcludeCurrentGoRoutine 以及 FilterGoRoutine。MockBuilder.When 的入参是一个函数，这个函数接受用户调用 target 时传递的参数作为参数，返回一个布尔值，当且仅当其值为 true 时才会调用 hook，否则走原来的 target 的逻辑。IncludeCurrentGoRoutine、ExcludeCurrentGoRoutine 和 FilterGoRoutine 都是在 goroutine 维度来判断是否做 patch，具体而言是根据当前 goroutine 的 gid 来做的，每一次 patch 只能设置一个条件，目前还不支持类似 `include(goroutineA) and exclude(goroutineB)` 这种逻辑。在实现上，mockey 在用户提供的 hook 的基础上包装了一层，也就是 [Mocker.buildHook](https://github.com/bytedance/mockey/blob/v1.1.1/mock.go#L175-L235) 这个方法做的事情，它利用 `reflect.MakeFunc` 创建了一个新的函数，这个函数会根据 When 和 FilterGoRoutine 的设置来分别按需调用用户提供的 hook 或 proxy，调用 hook 时就是 patch 生效的状态，调用 proxy 时就是不生效的状态。

为了方便用户感知 patch 是否生效，Mocker 有 Mocker.Times 和 Mocker.MockTimes 这两个方法，前者代表用户调用了几次 target 函数，但调用时可能走了 hook 的逻辑，也可能走了原 target 的逻辑，后者代表用户走了几次 hook 的逻辑，这两个值也都是在 Mocker.buildHook 这个方法构建出来的函数中维护的。