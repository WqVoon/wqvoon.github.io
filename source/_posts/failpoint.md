---
title: 浅析 pingcap/failpoint 源码
date: 2023-2-10 22:32:34
categories:
 - [Golang]
description: 包括使用方式、代码重写实现、故障注入实现
---

# 前言

golang 是一门设计非常优良的语言，它提供了 `go/ast`、`go/parser` 等一系列标准库来解析自身，通过这些工具的相互配合，使用者可以从一份标准的 golang 源码获取其对应的 AST 表示，并基于 AST 来做具体的业务逻辑。尽管 golang 的语法很简单，但其 AST 的构成依然比较复杂，所以我一直想找到一个应用了 AST 的项目来学习，而 pingcap 的 [failpoint](https://github.com/pingcap/failpoint/tree/2eaa328) 就是这样一个项目。

在正式开始之前，先安利下 https://astexplorer.net/ 这个网站，它提供各种语言的 “源码 -> AST” 的实时转换，并可以同步高亮两边的内容，用来了解各种代码的语法树结构非常方便。

# failpoint 的使用方式

在 failpoint 的代码库中，failpoint-ctl 这个目录下有一个 main.go 文件，如果你在代码库目录中执行 make 命令，就会以这个 main.go 为入口文件构建一个 cli 工具。这个工具提供 enable 和 disable 两个命令，前者驱动 failpoint 的代码重写器，后者驱动 failpoint 将重写后的代码恢复到原来的样子。

当你在自己的代码中引入 failpoint，并使用了它的 Marker 函数编写自己的故障注入逻辑后，对代码目录执行 `failpoint-ctl enable` ，failpoint 就会把文件中的 Maker 函数替换成一些有意义的节点，这个重写后的文件会替代原来的文件，而原文件的名字后面会加上 `__failpoint_stash__` 的后缀，因为这样在编译时新老文件就不会相互影响。

failpoint 作为一个外部库，提供了一些 Marker 函数供用户使用，其中最重要的是`failpoint.Inject` 和 `failpoint.InjectContext`。以 Inject 函数举例，假设有如下代码：

```go
	failpoint.Inject("test", func(_ failpoint.Value) {
		fmt.Println("hello world")
	})
```

在经过 failpoint-ctl 的代码重写后，这个代码就会变成下面的样子：

```go
	if _, _err_ := failpoint.Eval(_curpkg_("test")); _err_ == nil {
		fmt.Println("hello world")
	}
```

其中 `_cur_pkg_` 起到类似宏一样的效果，作用是在用户提供的字符串中添加文件所在的包前缀，这样即便不同的包使用了相同的自定义字符串，也不会相互影响。另外，Inject 函数的第二个参数是一个 `interface{}`，所以虽然这里需要提供一个函数，但这个函数的签名有多种选择，比如可以直接不提供 failpoint.Value。

除此之外，还有一些用于辅助 Inject 的 Marker 函数，比如 `failpoint.Break`，`failpoint.Label`，`failpoint.Continue` 等等，你会发现这些函数的名字和 golang 中的关键字是一样的，这不是巧合，因为它们确实是以对应的 golang 关键字的形式来生效的。事实上，这些 Marker 都是空函数，所以在正常情况下它们会被编译器优化掉，但对于 golang 的 AST 而言，它们都是能被解析到的树上的节点，所以 failpoint 在遍历 AST 时可以对它们做进一步的处理。

总而言之，通过组合 failpoint 提供的各种 Marker 函数，就可以构建一条完整的程序执行链路，这条链路在代码重写前会被编译器优化掉（也就等于没有这条链路），而代码重写后则会实实在在的影响程序的流程。通常而言，这条重写后的链路以 Inject 中第二个参数对应的函数为起点（在重写后它变成了 Eval 的 if 语句块），而这个函数能否被执行则取决于 Inject 的第一个参数。

Inject 的第一个参数是一个被称为 failpath 的自定义字符串，前面提到这个字符串在代码重写后会自动加上包名作为前缀，所以你不用担心自己定义的字符串会与其他包中已有的 failpath 相互冲突。在 Inject 被重写成 Eval 后，当且仅当对应的 if 为 true 时才会执行用户自定义的逻辑，那么如何将这个 if 变成 true 呢，failpoint 提供了环境变量与 HTTP 两种方式，这部分放到后面的小节来展开讲。

# 代码重写实现

TBD

# 故障注入实现

TBD