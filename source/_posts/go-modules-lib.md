---
title: 关于 go modules 的一个小实验
date: 2023-05-13 23:17:15
categories:
 - [Golang]
description: 假设 a 依赖 b 和 c，b 也依赖 c，那么最终一共有几个 c
---

# 问题

最近在做项目时和同事聊到这样一个问题，假设有 a、b、c 三个库，它们之间的依赖关系如下：

```shell
a -> c
a -> b -> c
```

也就是说，如果把整个依赖关系看作一棵以 a 为根节点的树，那么它有两条路径可以走到 c。

此时的问题是，如果 a 依赖的 c 与 b 依赖的 c 版本相同，整个项目中存在几个 c？如果 c 的版本不同，整个项目中存在几个 c？

# 结论

先说结论，go modules 在决策外部依赖的版本时会使用**最小版本选择**（[Minimal Version Selection](https://research.swtch.com/vgo-mvs)）算法，这个算法最终保证项目会使用最合适的最低版本的外部依赖，其中版本使用**语义化版本**（[SemVer](https://semver.org/lang/zh-CN/)）。对于本文想要探究的问题而言，答案是当主版本号未变化时最终整个项目只会存在一个 c，主版本号发生变化时会存在多个 c。

# 实验过程

> 以下实验使用 1.18 版本的 golang

为了验证这个问题，我们创建如下三个库：testlib1、testlib2、testlib3，分别对应前文所述的 c、b、a。

## 准备 testlib1（也就是前文的 c）

在 testlib1 中，我们写入如下的代码：

```go
package testlib1

import "fmt"

var globalMap map[string]string = make(map[string]string)

const prefix = "testlib1@v0.0.1 "

func Register(k, v string) {
	fmt.Println(prefix + "Register")
	globalMap[k] = v
}

func GetAll() {
	fmt.Println(prefix + "GetAll")
	fmt.Println(globalMap)
}

```

这段代码的逻辑很简单，我们创建了一个全局的 map，并提供一个 Register 方法向 map 中写入内容，提供一个 GetAll 方法输出全局 map 中的内容。此外为了观察版本，我们在 Register 与 GetAll 中输出当前的版本。

将这段代码进行 commit，并打上 **0.0.1** 的 tag。然后分别将 prefix 常量中的版本号改为 **0.0.2，0.2.1，2.0.1**，并创建对应的 commit 与 tag，做完这些操作，我们将拥有一个包含了 4 次 commit 的 testlib1。为了能够使用这个库，可以将它发布到 [github](https://github.com/WqVoon/testlib1) 上。

此时 testlib1 的状态如下：

```shell
testlib1@v0.0.1 --依赖--> 无
testlib1@v0.0.2 --依赖--> 无
testlib1@v0.2.1 --依赖--> 无
testlib1@v2.0.1 --依赖--> 无
```

## 准备 testlib2（也就是前文的 b）

在 testlib2 中，首先通过 `go get github.com/wqvoon/testlib1@v0.0.1` 拉取最低版本的 testlib1，然后在 testlib2 中写入如下的代码：

```go
package testlib2

import (
	"fmt"

	"github.com/wqvoon/testlib1"
)

const prefix = "testlib2@v0.0.1 "

func WrapperRegister(k, v string) {
	fmt.Println(prefix + "WrapperRegister")
	testlib1.Register(k, v)
}

func WrapperGetAll() {
	fmt.Println(prefix + "WrapperGetAll")
	testlib1.GetAll()
}

```

在 testlib2 中，我们包装了 testlib1 的 Register 和 GetAll，在原本的逻辑之外输出了 testlib2 自身的版本信息。

同样，我们对这段代码进行 commit，并打上 **0.0.1** 的 tag。然后，我们用 `go get github.com/wqvoon/testlib1@v0.0.2` 拉取 **0.0.2** 版本的 testlib1，修改 prefix 为 "testlib2@v0.0.2 "，然后进行 commit，并打上 **0.0.2** 的 tag。做完这些操作，我们将拥有一个包含 2 次 commit 的 testlib2，为了能够使用这个库，可以将它发布到 [github](https://github.com/WqVoon/testlib2) 上。

此时 testlib2 的状态如下：

```shell
testlib2@v0.0.1 --依赖--> testlib1@v0.0.1
testlib2@v0.0.2 --依赖--> testlib1@v0.0.2
```

## 准备 testlib3（也就是前文的 a）

在 testlib3 中，首先通过  `go get github.com/wqvoon/testlib2@v0.0.1` 拉取最低版本的 testlib2，根据我们之前的代码，它内部依赖 0.0.1 版本的 testlib1。然后在 testlib3 中写入如下的代码：

```go
package main

import (
	"github.com/wqvoon/testlib1"
	"github.com/wqvoon/testlib2"
)

func main() {
	testlib2.WrapperRegister("name", "hygao")
	testlib1.GetAll()
}

```

下面来进行一些 `go run` 与 `go get` 的交替操作：

```shell
# testlib1@v0.0.1 / testlib2@v0.0.1
➜  testlib3 go run .
testlib2@v0.0.1 WrapperRegister
testlib1@v0.0.1 Register
testlib1@v0.0.1 GetAll
map[name:hygao]

# testlib1@v0.0.2 / testlib2@v0.0.1
➜  testlib3 go get github.com/wqvoon/testlib1@v0.0.2
go: upgraded github.com/wqvoon/testlib1 v0.0.1 => v0.0.2
➜  testlib3 go run .
testlib2@v0.0.1 WrapperRegister
testlib1@v0.0.2 Register
testlib1@v0.0.2 GetAll
map[name:hygao]

# testlib1@v0.2.1 / testlib2@v0.0.1
➜  testlib3 go get github.com/wqvoon/testlib1@v0.2.1
go: upgraded github.com/wqvoon/testlib1 v0.0.2 => v0.2.1
➜  testlib3 go run .
testlib2@v0.0.1 WrapperRegister
testlib1@v0.2.1 Register
testlib1@v0.2.1 GetAll
map[name:hygao]

# testlib1@v2.0.1 / testlib2@v0.0.1
➜  testlib3 go get github.com/wqvoon/testlib1@v2.0.1
go: github.com/wqvoon/testlib1@v2.0.1: invalid version: module contains a go.mod file, so module path must match major version ("github.com/wqvoon/testlib1/v2")
```

上面的输出中，有一些值得关注的点：

- 首先，上面的例子能够说明最终整个项目只有一个 testlib1，因为我们在 testlib3 中调用 `testlib2.WrapperRegister` 来向全局 map 中写入内容，调用 `testlib1.GetAll` 从 map 中读取内容，而不论 testlib3 使用的 testlib1 是否与 testlib2 中使用的 testlib1（也就是 0.0.1 版本）相同，输出的结果都是相同的。如果项目中存在多个 testlib1，那么某次 `go run` 应该输出空的 map。
- 其次，尽管 testlib2 中要求 testlib1 的版本是 0.0.1，但如果 testlib3 使用了更新的版本，那么根据最小版本选择算法，整个项目也会使用 testlib3 指定的版本，这一点可以通过 `go run` 中输出的 testlib1 的版本来验证，可以发现它是与 `go get` 声明的版本保持一致的。
- 最后，go modules 使用的版本遵循**语义化版本**（[SemVer](https://semver.org/lang/zh-CN/)），根据这个规范，x.y.z 中的 y 和 z 变动时都是向下兼容的，此时最小版本选择算法可以放心使用 y.z 更大的版本而不必担心项目无法正常编译。但当 x 发生变化时，这个假设就不成立了，此时 go modules 对我们有一些更高的要求。

## 准备 v2 版本的 testlib1（也就是前文的 c）

正如上面 `go get` 的提示，为了使用主版本号更新了的 testlib1，需要将 go.mod 文件中的 module 从 `github.com/wqvoon/testlib1` 改为 `github.com/wqvoon/testlib1/v2`。同时为了与前面失败的 2.0.1 作区分，我们修改 prefix 为 "testlib1@v2.0.2 "，然后做 commit 并打上对应的 tag 后将其提交到 github 上。

此时回到 testlib3，我们可以通过 `go get github.com/wqvoon/testlib1/v2@v2.0.2` 来拉取 v2 版本的 testlib1，拉取成功后将代码修改为如下内容：

```go
package main

import (
	"github.com/wqvoon/testlib1"
	testlib1v2 "github.com/wqvoon/testlib1/v2"
	"github.com/wqvoon/testlib2"
)

func main() {
	testlib2.WrapperRegister("name", "hygao")
	testlib1.GetAll()
	testlib1v2.GetAll()
}

```

继续执行 `go run`：

```go
➜  testlib3 go run .
testlib2@v0.0.1 WrapperRegister
testlib1@v0.0.1 Register
testlib1@v0.0.1 GetAll
map[name:hygao]
testlib1@v2.0.2 GetAll
map[]
```

从上面的输出中我们可以发现，此时整个项目中已经存在两个 testlib1 了，testlib2 使用 **0.0.1** 版本的 testlib1，testlib3 使用 **2.0.2** 版本的 testlib1，两者的全局 map 也不相同，所以 `go run` 输出了两个内容不同的 map。

## 一点小拓展

上面的几组测试中，我们都保证了 testlib3 依赖的 testlib1 的版本大于 testlib2 依赖的 testlib1 版本。下面我们测试一下小于的情况，回到 testlib3，执行 `go get github.com/wqvoon/testlib2@v0.0.2` 拉取 **0.0.2** 版本的 testlib2，根据我们前面的配置，这个版本的 testlib2 依赖 **0.0.2** 版本的 testlib1。

更新了 testlib2 后，如果我们继续在 testlib3 中执行 `go get github.com/wqvoon/testlib1@v0.0.1` ，就会发现 golang 进行了如下的输出：

```shell
➜  testlib3 go get github.com/wqvoon/testlib1@v0.0.1
go: downgraded github.com/wqvoon/testlib1 v0.0.2 => v0.0.1
go: downgraded github.com/wqvoon/testlib2 v0.0.2 => v0.0.1
```

也就是说，golang 将 testlib2 也进行了降级，使整个项目能够满足用户对 testlib1 的版本要求。

那么，是否有办法强制使用 **0.0.2** 版本的 testlib2，但却使用 **0.0.1** 版本的 testlib1 呢？答案是可以使用 replace，此时 testlib3 的 go.mod 文件如下：

```go.mod
module github.com/wqvoon/testlib3

go 1.18

require (
	github.com/wqvoon/testlib1 v0.0.2
	github.com/wqvoon/testlib2 v0.0.2
)

replace github.com/wqvoon/testlib1 => github.com/wqvoon/testlib1 v0.0.1

```

然后执行 `go run` 就可以看到如下的输出了：

```shell
➜  testlib3 go run .
testlib2@v0.0.2 WrapperRegister
testlib1@v0.0.1 Register
testlib1@v0.0.1 GetAll
map[name:hygao]
```

