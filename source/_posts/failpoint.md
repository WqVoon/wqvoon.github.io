---
title: 浅析 pingcap/failpoint 源码
date: 2023-2-10 22:32:34
categories:
 - [Golang]
description: 包括使用方式、代码重写实现、故障注入实现
---

# 前言

golang 是一门设计非常优良的语言，它提供了 `go/ast`、`go/parser` 等一系列标准库来解析自身，通过这些工具的相互配合，使用者可以从一份标准的 golang 源码获取其对应的 AST 表示，并基于 AST 来做具体的业务逻辑。尽管 golang 的语法很简单，但其 AST 的构成依然比较复杂，所以我一直想找到一个应用了 AST 的项目来学习，而 pingcap 的 [failpoint](https://github.com/pingcap/failpoint/tree/2eaa328) 就是这样一个项目。

在正式开始之前，先安利 https://astexplorer.net/ 这个网站，它提供各种语言的 “源码 -> AST” 的实时转换，并可以同步高亮两边的内容，用来了解各种代码的语法树结构非常方便。

# failpoint 的使用方式

TBD

# 代码重写实现

TBD

# 故障注入实现

TBD