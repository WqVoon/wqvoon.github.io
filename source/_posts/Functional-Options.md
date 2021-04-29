---
title: Functional-Options
date: 2021-04-30 00:04:32
categories: Golang
description: 一种优雅的初始化结构体的方式
---

# 0x00 前言

到了大三，学校的课设开始不限制实现的语言了，考虑到为未来打基础，于是我大部分的课设都使用 Golang 来完成，以期在实践中逐渐熟练这门简洁却高效的语言。

在使用的过程中，经常会遇见对结构体进行初始化的需求，如果只是简单的字段还好，直接通过字面量来初始化即可，然而对于一些拥有复杂结构及依赖的结构体，其初始化不论是用户友好性还是可读性上都不适合使用字面量来初始化，在 Golang 的标准库中通常采用返回结构体指针的 New 函数来实现（如 list.New，sync.NewCond），这样在函数中屏蔽了相关的实现细节，以让用户能够聚焦在简单的使用上。

然而，Golang 目前并不支持函数的重载，这导致 New 函数的特征标（signature）是写死的，函数需要什么参数，用户就只能传递什么参数来初始化相应的字段。如果想达到前文所述的易用，那么参数就不该设置得太多；但是如果想给用户足够的能力来按需设置结构体，那么参数就不该设置得太少，这使得开发者很难找到一个平衡点，来设计方便高效的参数进行初始化。

有没有什么方法，能使用同一个初始化函数，通过提供不同的参数来完成对结构体不同程度的初始化呢？

# 0x01 解决方法及原理

最近在逛[左耳耗子老师的博客](https://coolshell.cn/articles/21146.html)的时候偶然看到了如题所述的 Functional Options 模式，该模式非常优雅地利用闭包和可变参数等性质来解决了前文所述的问题，下面给出一个例子：

```go
package main

import (
	"fmt"
)

type Person struct {
	name  string
	age   int
	hobby string
}

type withFunc func(*Person)

func withName(name string) withFunc {
	return func(p *Person) {
		p.name = name
	}
}

func withAge(age int) withFunc {
	return func(p *Person) {
		p.age = age
	}
}

func withHobby(hobby string) withFunc {
	return func(p *Person) {
		p.hobby = hobby
	}
}

func makePerson(funcs ...withFunc) *Person {
	ret := &Person{}
	for _, f := range funcs {
		f(ret)
	}
	return ret
}

func main() {
	p1 := makePerson(withName("Yuren"))
	p2 := makePerson(withName("Yuren"), withAge(21))
	p3 := makePerson(withName("Yuren"), withAge(21), withHobby("Program"))

	fmt.Printf("%+v\n%+v\n%+v\n", p1, p2, p3)
}

```

对于所谓的 New 函数，我个人比较习惯于将其命名为 make+结构体名 的形式，这里就请忽略这个非常不 Golang 的函数名，转而聚焦到函数的实现上。

可以看到，makePerson 函数本身接收一个 withFuncs 的可变参数列表，withFuncs 作为一种类型定义，其本质上是一个需要传递 Person 指针的函数。按照这种特征标，代码中的 withName，withAge 和 withHobby 的返回值都是符合 withFuncs 类型的实现，由于这三者原理上相同，这里只用 withName 来举例。

```go
func withName(name string) withFunc {
	return func(p *Person) {
		p.name = name
	}
}
```

withName 的函数定义如上，可以看到其返回了一个 withFunc 类型的函数。该函数利用闭包将传递给外层 withName 的 name 参数绑定在其作用域内，使得 withFunc 函数返回后依然具备访问 name 变量的能力，而该函数本身做的事情就是将传递进来的 Person 指针指向的实例中的 name 字段设置为 name 变量的值。

具体的 Person 指针的传递发生在 makePerson 函数调用的时候，即 p1~p3 处，在调用时传递了需要的 with* 函数的调用，将其返回的 withFunc 类型的函数放到了 makePerson 的参数列表中。

makePerson 做的事情就是用待返回的 Person 指针来消耗可变参数列表中的 withFunc 函数，以使其内部的字段被函数初始化成闭包内保留的值。

# 0x2 总结

本文试图通过抛出笔者平时遇到的结构体初始化的矛盾，进而通过学习给出相应的解决办法，同时阐述相关的原理。

