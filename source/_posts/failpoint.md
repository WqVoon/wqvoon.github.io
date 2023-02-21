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

## 重写

如前所述，代码重写的目的在于将 Marker 函数转变为有意义的 golang 关键字或 Eval 函数调用，这部分逻辑被定义在 code/rewriter.go 和 code/expr_rewriter.go 中，与之相对的，code/restorer.go 用于实现代码的恢复。

先来看 rewriter 的逻辑，它的 [Rewrite](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L666) 方法被 main.go 所驱动，所以这是代码重写器的逻辑入口，这个函数的最终目的是获取某个 path 下的一批文件，针对这些文件调用 [RewriteFile](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L579) 方法。具体来说，Rewrite 方法寻找那些[引入了 failpoint](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L703-L706) 的 [go 源码文件](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L675)，因为只有这些文件才有可能使用各种 Marker 函数，由于这里仅需要判断“是否引入了 failpoint” 这个问题，所以调用 `parser.ParseFile` 时传递了 `parser.ImportsOnly` 选项，代表仅仅解析文件的 ImportSpec 节点。

RewriteFile 方法首先用当前解析的文件[初始化 Rewriter 结构中的一些字段](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L593-L612)，然后找出 file.Decls 中的 FuncDecl，即函数定义，并对它们[调用 rewriteFuncDecl](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L619) 进行语法树的重写，除此之外，RewriteFile 还完成 Binding 文件的写入（即 \_cur\_pkg\_ 这个“宏”的定义）、重命名原文件（在文件名后面添加后缀）以及将改写后的 AST 写入与原文件同名的文件（通过 format.Node 函数实现）等一系列工作，当 Rewrite 对找出的所有目标文件都调用了 RewriteFile 后，整体的代码重写就完成了。

从 [rewriteFuncDecl](https://github.com/pingcap/failpoint/blob/master/code/rewriter.go#L571-L576) 方法开始，failpoint 就开始处理语法树上的节点了，这里没有直接使用 golang 标准库提供的 Walk 语法，而是针对一系列节点实现了 rewriteXXX 函数，比如 `rewriteIfStmt`、`rewriteAssign` 等等，从 Stmt 开始一层一层地处理 AST。为什么没有直接使用 Walk 呢，因为在遍历的过程中需要对节点做修改，而且还要能够感知父节点，而这些用 Walk 来做会非常麻烦。

这一系列的 rewrite 非常好地覆盖了所有能够出现 Marker 函数的地方，是学习 golang AST 的绝佳样例。而这些 rewrite 的尽头是被定义在 code/expr_rewriter.go 中的 [exprRewriters](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/code/expr_rewriter.go#L26-L35)，这是一个 map，key 是 Marker 函数的名字，value 是对应的重写方法。当 failpoint 遍历到 SelectorExpr 节点时，会判断是否为 `failpoint.XXX` ，并[使用 XXX 到 exprRewriters 这个 map 中去寻找对应的重写函数，然后调用它来完成代码的重写](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/code/rewriter.go#L318-L322)。

在调用这些重写函数时，failpoint 将 CallExpr 传了下来，这是重写函数对应 AST 节点的父节点，所以能够直接通过修改这个父节点来将 Marker 函数从 AST 中剔除掉。重写函数的逻辑基本相同，都是对 AST 做一些校验，然后构建新的节点来完成替换，这里以 [rewriteInject](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/code/expr_rewriter.go#L37) 方法为例来过一下代码重写的过程，其他函数基本同理。

我们前面给出了 Inject 函数的使用方式，它需要接受两个参数，分别是 failpath 与一个自定义的函数，通常来讲，编译器或 IDE 能够保证这个函数调用的合法性，不过 rewriteInject 中还是通过判断 CallExpr.Args 的长度来再次保证了下。验证完长度后，rewriteInject 从 CallExpr.Args 中取出了这两个参数，第一个参数只要保证是一个 Expr 即可，因为生成的 Eval 函数调用的第一个参数接受的也是一个 Expr，所以这里不需要去确认具体的 Expr 类型。而第二个参数的要求则相对严格，它只能是 [nil、没有参数的函数和接受一个 failpoint.Value 参数的函数](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/code/expr_rewriter.go#L55-L66)这三种类型中的某一个。在验证完了参数的合法性后，rewriteInject 就会生成一系列的 AST 节点，这些节点就代表上文所述的 if 中调用 Eval 的代码，以及从 Inject 的自定义函数中提取出来的函数体内容。

## 恢复

与代码重写不同，代码的恢复就比较简单了，如果你只想要将代码恢复到重写前的样子，只需要用 xxx.go_\_failpoint\_stash\_\_ 覆盖 xxx.go，然后删除 \_cur\_pkg\_ 所在的文件即可。不过 failpoint 没有做得这么粗暴，它在实现上读取了覆盖前的文件内容，记为 a，然后用 Rewriter 的 Rewrite 方法获取a 对应的重写后的内容 b，而此前 a 已经有一份被保存到文件中的重写后的内容 c，所以 failpoint 会对 b 和 c 做一个 diff，找出 c 在 b 的基础上做的修改，然后将它应用到 a 中。这样做的好处在于，如果你在代码重写后修改了 c，只要代码所在的行数没有发生变化，那么在恢复时这个修改就可以继续保留下来。

# 故障注入实现

TBD