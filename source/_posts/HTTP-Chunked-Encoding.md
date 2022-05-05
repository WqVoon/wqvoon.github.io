---
title: 浅谈 Http Chunked Encoding
date: 2022-05-04 19:55:52
categories:
 - [前端]
 - [Golang]
description: 一些关于 Chunked Encoding 的想法与实践
---

# 前言

在 HTTP 的消息头（即请求头和响应头）中，有一个叫 `Content-Length` 的字段，用于表示消息体的大小。早期版本的 HTTP 通过服务端发起的断开连接来表示一个消息的结束，这种方式在多数情况下都工作的很好，但是它存在两个比较严重的问题。第一是，在没有一个表示完整消息大小的字段来帮助检查的情况下，客户端无法得知连接的断开是正常情况还是由于消息的传输发生了异常；第二是，在多个 HTTP 消息共用同一个 TCP 连接的场景下，客户端无法找到不同消息间的边界。

所以，HTTP 的规范要求 `Content-Length` 字段是必须被提供的（虽然实际测试时发现如果服务端没有提供，很多工具依然会将关闭连接作为默认的消息边界）。

但是，有种消息，它是没有这个字段的，取而代之地使用另一种方式来确保消息的完整性，它就是这篇文章的主角，Chunked Encoding，一种消息的传输编码（Transfer Encoding）。

# Chunked Encoding 与 curl

我最早了解到 Chunked Encoding 恰恰是在用 curl 来测试服务端不提供 `Content-Length` 会发生什么时。一般来讲，如果你使用 HTTP 的框架提供服务，那么这个消息头是会被框架来处理的。所以最简单的一种绕过框架、发送一个没有这个字段的响应的方式，就是直接使用 TCP，比如在 golang 中你可以编写这样的代码：

```go
func TCPServer() {
	listener, err := net.Listen("tcp", "localhost:8080")
	if err != nil {
		panic(err)
	}

	for {
		conn, err := listener.Accept()
		if err != nil {
			panic(err)
		}

		go func() {
			defer conn.Close()
			conn.Write([]byte("HTTP/1.1 200 OK\r\n" +
				"Date: Wed, 04 May 2022 12:38:41 GMT\r\n" +
				"Content-Type: text/plain; charset=utf-8\r\n" +
				"\r\n1234567890"))
		}()
	}
}
```

代码不是很标准，因为这个程序没有读取请求而直接发送响应，不过这无伤大雅。代码主要做的事情就是发送一个没有 `Content-Length` 请求头字段的响应，但是在请求体里有 `1234567890` 这样的内容。这时如果执行它，并且使用 `curl -v localhost:8080`，那么在 curl 的输出中可以发现 ` no chunk, no close, no size. Assume close to signal end` 这样的输出，这证明了我在前言中的描述。

那么，Chunked Encoding 的响应体是什么样的呢，为什么它会被 curl 区别对待？我们仍然可以用 golang 和 curl 进行测试。

golang 的 http 包本身就支持 Chunked Encoding，它的 http.ResponseWriter 接口可以被显式转换成 Flusher 接口，这个接口提供一个 Flush 方法，如果调用它，那么它会以 Chunked Encoding 方式处理发送的内容，于是我们可以编写这样的代码：

```go
func HTTPServer() {
	http.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
		flusher, ok := rw.(http.Flusher)
		if !ok {
			panic("can not convert rw to flusher")
		}

		for i := 0; i < 5; i++ {
			rw.Write([]byte(fmt.Sprintf("message #%d\n", i)))
			flusher.Flush()
			time.Sleep(time.Second)
		}
	})

	if err := http.ListenAndServe("localhost:8080", nil); err != nil {
		panic(err)
	}
}
```

这段代码试图分五次发送响应体，每次间隔一秒钟。如果我们使用 `curl -v localhost:8080` ，那么会发现响应体确实如预期一般每隔一秒发送一部分，同时响应头中有 `Transfer-Encoding: chunked` 这样的字段表示这个响应是以 Chunked Encoding 的方式被发送的，而且这个响应也确实没有 `Content-Length` 这个字段。

更进一步的，如果再为 curl 加上 --raw 参数，也就是使用 `curl -v --raw localhost:8080`，那么就可以获取原始的响应体内容，这个命令的结果是这样的：

```shell
b
message #0

b
message #1

b
message #2

b
message #3

b
message #4

0

```

再进一步，如果命令变成了 `curl -v --raw localhost:8080 | hexdump -C` ，就可以得到这样的响应体内容：

```shell
00000000  62 0d 0a 6d 65 73 73 61  67 65 20 23 30 0a 0d 0a  |b..message #0...|
00000010  62 0d 0a 6d 65 73 73 61  67 65 20 23 31 0a 0d 0a  |b..message #1...|
00000020  62 0d 0a 6d 65 73 73 61  67 65 20 23 32 0a 0d 0a  |b..message #2...|
00000030  62 0d 0a 6d 65 73 73 61  67 65 20 23 33 0a 0d 0a  |b..message #3...|
00000040  62 0d 0a 6d 65 73 73 61  67 65 20 23 34 0a 0d 0a  |b..message #4...|
00000050  30 0d 0a 0d 0a                                    |0....|
00000055
```

这样看来就很明显了：Chunked Encoding 发送的每一部分响应体，都会以一个 16 进制的数字作为开始，这个数字表示这部分响应体的长度，后面接 `\r\n` ，然后是具体的响应体内容，再接 `\r\n`标记这部分响应的结束（上面例子中倒数第三列的 0a 是前面 `fmt.Sprintf("message #%d\n", i)` 中的 \n，并不是 Chunked Encoding 的结构）。最终，以 0 表示整个响应的结束，由于长度为 0，那么紧随其后的只有两个 `\r\n`。

# Chunked Encoding 与 Golang http 的客户端

golang 对 Chunked Encoding 的支持不仅限于服务端，比如我们还是使用上面的代码作为服务端，但是编写这样的代码来作为客户端：

```go
func HTTPClient() {
	rsp, err := http.Get("http://localhost:8080")
	if err != nil {
		panic(err)
	}

	buf := make([]byte, 512)
	for {
		len, err := rsp.Body.Read(buf)
		if err != nil {
			if err == io.EOF {
				fmt.Println("Done")
				return
			}
			panic(err)
		}

		fmt.Println(len, string(buf[:len]))
	}
}
```

那么在运行它后，会得到如下的输出（每部分同样会间隔一秒）：

```shell
11 message #0

11 message #1

11 message #2

11 message #3

11 message #4

Done
```

通过前面的内容我们可以知道，响应体的内容是包含长度、`\r\n`、部分响应体内容的，但是如果我们直接使用 golang 的 http.Response.Body.Read 方法，就可以直接拿到响应体的有效内容部分，不需要我们自己去做一些额外的操作（比如读取长度，跳过CRLF，验证长度等等）。

# Chunked Encoding 与 Golang http 的服务端

现在让我们把关注点放回到服务端上，不难想象，这种不需要提前计算 `Content-Length`、动态持续生成内容的消息类型，在一定程度上是可以实现 Websocket 的功能的，因为常规 HTTP 的痛点就在于它是一问一答的形式，而且回答的内容在被发送前就要确定下来。事实上，如果读者熟悉 Kubernetes 的 watch 机制，就会知道它是同时支持 Chunked Encoding 和 Websocket 两种方式的。

所以我们可以编写下面这样的一个小例子来演示 Chunked Encoding 的这种能力：

```go
package main

import (
	"fmt"
	"net/http"
	"sync"
)

// 用来线程安全地对 connections 变量使用 append
var globalLock = &sync.Mutex{}

// 用来保存所有的 Connection 对象
var connections []*Connection

func main() {
	// 创建一个 Connection 对象，并将它放入 connections 切片中
	http.HandleFunc("/watch", func(rw http.ResponseWriter, r *http.Request) {
		c := NewConnection(rw)

		globalLock.Lock()
		fmt.Println("Append one")
		connections = append(connections, c)
		globalLock.Unlock()

		c.Send("Start Watching...\n")
		select {} // 避免函数退出，从而保留住连接，这会有协程泄露的问题，但是这里先不管
	})

	// 对 connections 中的所有连接发送一条消息
	http.HandleFunc("/send", func(rw http.ResponseWriter, r *http.Request) {
		msg := r.URL.Query().Get("msg")
		for _, c := range connections {
			fmt.Println("Send one")
			c.Send(msg + "\n") // 这里加一个回车方便观察
		}
		rw.Write([]byte("Done"))
	})

	if err := http.ListenAndServe("localhost:8080", nil); err != nil {
		panic(err)
	}
}

// 代表一个 Chunked Encoding 连接，提供 Send 方法用于发送一部分响应体
type Connection struct {
	rw      http.ResponseWriter
	flusher http.Flusher
	lock    *sync.Mutex
}

func NewConnection(rw http.ResponseWriter) *Connection {
	flusher, ok := rw.(http.Flusher)
	if !ok {
		panic("can not convert rw to flusher")
	}

	return &Connection{rw, flusher, &sync.Mutex{}}
}

// 以 Chunked Encoding 的方式发送响应体的一部分
func (c *Connection) Send(msg string) {
	// 这里的加锁是必须的，因为下面的操作并不是原子的
	// 而多协程同时写响应体会导致 Chunked Encoding 的结构乱掉，从而引发客户端异常
	c.lock.Lock()
	defer c.lock.Unlock()

	c.rw.Write([]byte(msg))
	c.flusher.Flush()
}

```

代码有些长，主要的功能是提供了 /watch 和 /send 两个 path，前者用于和服务端保持一个连接，并从这个连接中接受被服务端下发的内容，后者则可以传递一个 msg 的 query 参数，其内容会被广播给所有的 Chunked Encoding 连接。

运行这个程序，然后多准备几个终端窗口，均执行 `curl -v localhost:8080/watch`，待它们都显示 `Start Watching...` 消息后，再打开一个终端窗口，执行  `curl localhost:8080/send\?msg=aaaaa`，就可以发现前面的所有窗口都收到了 `aaaaa` 这个消息。而这，其实本质上和 k8s 的 watch 机制是一样的。

上面的代码仅仅起到抛砖引玉的作用，由于 Chunked Encoding 在一定程度上提供了类似全双工通信的能力，我们完全可以基于它实现更多，比如实时消息推送、聊天室等等。

# 杂谈

最近辞掉了公司实习生的身份，距离毕业后回去做正式员工还有大概一个多月的时间，想在这段时间内好好休息一下。由于手头的工作就只有毕业设计和毕业论文，便有了更充足的时间来兴趣驱动地学一些东西。近期在读《HTTP-The-Definitive-Guide》这本书，主要目的是更深入地了解一些 HTTP 的特性，其次也想借此锻炼一下自己的英语阅读能力。

不过我是乱序读的，目前暂定的阅读顺序是 `HTTPS -> Entity&Encoding -> Connection Management -> Cookie -> Cache `，其他的内容就按需添加。

这篇文章就是我在阅读了 `Entity & Encoding` 部分后，针对 http chunked encoding 这个特性的一个总结与实践。

