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

通常而言，failpoint 的使用者使用 Inject 函数的第一个参数，也就是 failpath 来标识一种故障，当然多个 Inject 的调用可以传递相同的 failpath，这时如果启用了这个 failpath，那么这些 Inject 都会被执行到。如前所述，Inject 函数在经历 AST 重写后会变成 Eval 函数，所以我们可以通过查看[这个函数的代码](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoints.go#L268-L276)来了解故障注入是如何发生的。

可以看到，Eval 的逻辑其实很简单，它直接调用了 [failpoints.Eval](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoints.go#L200-L215) 方法，failpoint 是一个全局的 Failpoints 结构，所以对它内部字段的操作很可能会导致并发问题，因此 failpoints.Eval 首先做的事情就是加锁，然后到 failpoints.reg 中根据用户传入的 failpath（也就是传给 Inject 的第一个参数）来寻找一个 fp，然后调用这个 fp 的 Eval 方法。fp 是什么呢，根据Failpoints 结构的[定义](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoints.go#L85-L89)，我们可以发现这是一个名为 Failpoint 结构（少了一个 `s`），它被定义在源码中的 [failpoint.go](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoint.go#L39-L44) 文件中。继续深入到 [Failpoint.Eval](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoint.go#L99-L112) 这个方法中，会发现这里也是先加了个锁，然后去调用了 fp.t.eval，具体来说，是一个名为 terms 的结构的 eval 方法，而这个 terms 则大有来头。

通过梳理上面的这条链路我们就可以知道，当 Inject 被重写为 Eval 时，它最终会通过用户传递的 failpath 找到一个 terms，然后执行它的 eval 方法，这个方法会拿到一个 failpoint.Value 和一个 error，而这两个正是重写后的 AST 的 if 语句块接受的两个局部变量。不难想到，我们需要一种人为可控的方式，来把 failpath 和 terms 关联起来，从而灵活地返回不同的值来制造出不同的故障。failpoint 提供了两种，分别是环境变量和 http server。

## 环境变量

failpoint 的 README.md 中有提到，可以通过给 GO_FAILPOINTS 这个环境变量传递特定格式的值，来用不同的方式启动 failpath，格式的定义是这样的：

```shell
[<percent>%][<count>*]<type>[(args...)][-><more terms>]
```

这一坨正则表达式一样的东西看起来不怎么直观，下面来看一个具体的例子：

```shell
GO_FAILPOINTS='main/test=5*return("hahaha")->50%return("walalala")'
```

这个环境变量带来的效果是，`main/test` 这个 failpath 的前五次执行会通过 failpoint.Value 返回字符串形式的 “hahaha”，此后的执行则有 50% 的概率会返回字符串形式的 “walalala”，另 50% 则什么都不做。

此外，如果想设置多个 failpath，则可以通过半角的分号来分割，比如：

```shell
GO_FAILPOINTS='main/test=5*return("hahaha")->50%return("walalala");main/test2=return(10086)'
```

这个例子设置了两个 failpath，`main/test` 和上面的逻辑是一样的，但与此同时也启用了 `main/test2` 这个 failpath，它固定通过 failpoint.Value 返回数值类型的 10086。

所以，通过在运行程序前设置 GO_FAILPOINTS 这个环境变量，就可以把某个 failpath 和一种链式的逻辑绑定起来，这个链上通过 `->` 连接了一系列的具体逻辑，从前向后只要有一个能执行就会停止后面的逻辑。事实上，在代码层面这些一个个逻辑就对应一个 [term](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L56-L66)，而一批 term 就组成了 [terms](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L45-L54)，正如我们上面提到的，failpath 就是和一个 terms 结构对应起来的。

在 failpoints.go 文件中，有一个 init 函数，这个函数在程序启动时会领先于 main 函数执行，它[读取了 GO_FAILPOINTS 这个环境变量](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoints.go#L62-L76)，通过半角分号分割出不同的 failpath，然后执行 Enable 函数来完成 failpath 与 terms 的绑定。这个函数和上面提到的 Eval 相同，都是层层包装，最终调用的是 [Failpoint.Enable](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoint.go#L52-L63) 这个函数，而这个 Failpoint 会被注册到全局 failpoints 的 reg 中，方便 Eval 在执行时通过 failpath 查找到。

Failpoint.Enable 接受一个名为 inTerms 的参数，这个参数的值其实就是上面环境变量中等号后面那一坨，具体是指 `5*return("hahaha")->50%return("walalala")` 和 `return(10086)`，这个 inTerms 会被传递给 newTerms 函数，这个函数非常关键，它最终的效果是把这坨表达式转换成对应语义的代码，这是通过遍历 inTerms 并根据语法调用一系列的 parseXXX 来实现的。

terms 结构中有一个 [term 数组](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L48-L49)，[terms.eval](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L111-L120) 方法在执行时会遍历这个数组，找到第一个 allow 方法返回 true 的 term，然后调用它的 do 方法并返回执行的结果。这里 allow 的判断就对应上面的 `5*` 和 `50%`，分别通过 [modCount](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L72-L80) 和 [modProb](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L82-L84) 来实现。而 do 方法则对应上面的 `return("hahaha")`，事实上，这个在语法中被称为 type 的部分取值有很多，被定义在 [actMap](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L301-L309) 中，每种取值对应一个函数。以 `return` 举例，它对应的函数 [actReturn](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L315) 的逻辑非常简单，就是直接将括号中的值解析并返回，解析是通过 [parseVal](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/terms.go#L263-L297) 函数来实现的，它能够解析字符串、数字以及布尔值。

所以总结下来，用户可以通过 GO_FAILPOINTS 这个环境变量控制一个或多个 failpath 在什么情况下被触发，failpoint 在程序启动时会将这个环境变量的值解析成对应逻辑的代码，当用户程序执行到 Eval 时就会触发这部分逻辑，从而按用户的意愿来决定返回怎样的值。

## HTTP Server

环境变量的方式虽然很灵活，但它的缺点在于一旦程序启动后就不可变了，一些大型系统的启动时间可能会很长，同样一些程序的状态也可能很难构造，所以我们需要一种能够在程序执行期间动态修改 failpath 对应 terms 的能力。

failpoint 通过在程序中嵌入一个 HttpServer 来实现这个功能，具体而言，用户在启动时可以通过 GO_FAILPOINTS_HTTP 传递一个 host，这个 host 在[程序启动时](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/failpoints.go#L77-L81)会被传递给 net.Listen 函数来获取一个 tcp 的 listener，并在这个 listener 上放置一个 HTTP 的[应用](https://github.com/pingcap/failpoint/blob/2eaa32854a6cece9be893bf4e3605c18586e9d6a/http.go#L51)。

通过查看对应的代码，可以发现这个 HTTPServer 把请求中的 URL.Path 视为 failpath，并接受 PUT、GET 和 DELETE 三种 HTTP 方法，分别用于启用某个 failpath、查询某个或全部的 failpath 状态以及禁用某个 failpath。

通过这种方式，就实现了程序运行期间动态注入故障的功能。