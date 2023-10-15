---
title: golang requests 源码解读
date: 2023-10-08 23:06:28
categories:
 - [Golang]
description: 本文对 github.com/carlmjohnson/requests 的 v0.21.11 版本源码进行说明
---

# 1. 前言

最近在公司做项目时要调用平台提供的大量 openAPI，尽管 golang 的 http 标准库能够满足需求，但为了实现功能需要写很长的代码，读起来也不是很舒服，所以就想在 github 上找找标准库的封装。想起很久前学 python 时学过的 requests 库，抱着试一试的心态搜索了一下，结果居然真的有 golang 版本的同名库。对着 readme 学了下，发现使用方式还真的蛮 gopher 的，作者还写了[一篇博客](https://blog.carlmjohnson.net/post/2021/requests-golang-http-client/)描述了自己的一些设计取舍，也非常有意思。

下面是一个发送 GET 请求时，使用标准库与 requests 对比的例子：

<table>
<thead>
<tr>
<th><strong>标准库</strong></th>
<th><strong>requests</strong></th>
</tr>
</thead>
<tbody>
<tr>
<td>


```go
req, err := http.NewRequestWithContext(ctx, 
	http.MethodGet, "http://example.com", nil)
if err != nil {
	// ...
}
res, err := http.DefaultClient.Do(req)
if err != nil {
	// ...
}
defer res.Body.Close()
b, err := io.ReadAll(res.Body)
if err != nil {
	// ...
}
s := string(b)
```
</td>
<td>

```go
var s string
err := requests.
	URL("http://example.com").
	ToString(&s).
	Fetch(ctx)
```

</td>
</tr>
<tr><td>需要 15+ 行</td><td>需要 5 行</td></tr>
</tbody>
</table>

可以看到对比起来，requests 版本的代码还是非常简单清晰的。



# 2. 源码解读

## 2.1. fetch 主流程

从上面的代码中可以看到，requests 发起请求时可以用链式调用的方式声明请求中的内容以及如何处理响应，这个链式调用以 `requests.URL` 开始，经过一系列的配置后，在 `Fetch` 调用处发起 http 请求。`requests.URL` 方法的定义非常简单，它构建了一个 `Builder` 的结构体，并将其 baseurl 字段设置为 `requests.URL` 方法的入参，而这个结构体的完整定义如下：

```go
type Builder struct {
	baseurl      string // 请求的基础链接，这里可以只写一部分，也可以直接写完整的链接
	scheme, host string // 如果有值则会覆盖 .baseurl 解析出的内容，比如 baseurl 是 http 请求，这里可以将 scheme 设置成 https
	paths        []string // 请求链接中 baseurl 之后的部分，可以写多个，会用 path.Join 拼接起来
	params       []multimap // 请求的 query 参数
	headers      []multimap // 请求头中的各个字段，key 会经过 http.CanonicalHeaderKey 的包装
	getBody      BodyGetter // 定义如何构造请求中的 body，是一个函数
	method       string // 请求方法，默认是 GET
	cl           *http.Client // 使用哪个 http.Client 发起请求，默认是 http.DefaultClient
	validators   []ResponseHandler // 在 .handler 之前调用的一系列函数，通常用来校验一些内容
	handler      ResponseHandler // 定义如何处理响应体中的内容，是一个函数
}
```

事实上，后续的一系列链式调用都是调用的这个结构体的方法，不同的方法用于填充不同的字段，然后在 `Fetch` 中以这个结构体的各个字段来构建 `http.Request` 结构并发送出去，而 `Fetch` 内部其实仅仅是调用了 `Request` 和 `Do` 两个方法，前者用于构建 `http.Request` 结构，后者则用于发送请求并处理响应，这两个函数的代码如下：

```go
func (rb *Builder) Request(ctx context.Context) (req *http.Request, err error) {
	u, err := url.Parse(rb.baseurl)
	if err != nil {
		return nil, fmt.Errorf("could not initialize with base URL %q: %w", u, err)
	}
	if u.Scheme == "" { // 如果 baseurl 未提供 scheme，那么默认采用 https 协议
		u.Scheme = "https"
	}
  if rb.scheme != "" { // Builder 的 scheme 字段优先级最高，可以通过 Scheme(string) 方法设置
		u.Scheme = rb.scheme
	}
	if rb.host != "" { // Builder 的 host 字段优先级最高，可以通过 Host(string) 方法设置
		u.Host = rb.host
	}
	for _, p := range rb.paths { // 可以通过 Path 或 Pathf 方法向 paths 中加入内容
		if strings.HasPrefix(p, "/") { // 如果某个 path 以 / 开头，那么重新计算完整的 path
			u.Path = p
		} else if curpath := path.Clean(u.Path); curpath == "." || curpath == "/" {
			u.Path = path.Clean(p)
		} else { // 否则与已有的 path 做 Join 操作
			u.Path = path.Clean(path.Join(u.Path, p))
		}
	}
	if len(rb.params) > 0 { // 如果提供了 query 参数，那么设置到 RawQuery 中
    q := u.Query() // 这里先从 u.Query() 中查了一下，所以 baseurl 里也可以提供 query 参数，但 Builder 中的优先级更高
		for _, kv := range rb.params {
			q[kv.key] = kv.values
		}
		u.RawQuery = q.Encode()
	}
	var body io.ReadCloser
	if rb.getBody != nil { // 如果 getBody 方法不为 nil，那么调用它来获取请求体，这里后面我们会重点提到
		if body, err = rb.getBody(); err != nil {
			return nil, err
		}
	}
	method := http.MethodGet // 默认使用 Get 方法，如果 getBody 方法不为 nil 说明有请求体，此时默认使用 Post 方法，而最终还是以 Builder 中的内容为准
	if rb.getBody != nil {
		method = http.MethodPost
	}
	if rb.method != "" {
		method = rb.method
	}
  // 根据上面的内容构造出 http.Request 结构，在函数结束时返回它
	req, err = http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.GetBody = rb.getBody // 这里将 getBody 赋值给了 req.GetBody，所以可能会重复调用，需要保证提供的 getBody 方法是幂等的

	for _, kv := range rb.headers {
		req.Header[http.CanonicalHeaderKey(kv.key)] = kv.values
	}
	return req, nil
}

func (rb *Builder) Do(req *http.Request) (err error) {
	cl := http.DefaultClient // 默认使用 http.DefaultClient，如果 Builder 设置了 client，那么以 Builder 为准
	if rb.cl != nil {
		cl = rb.cl
	}
	res, err := cl.Do(req) // 发起请求并获取响应
	if err != nil {
		return err
	}
	defer res.Body.Close() // 在函数结束时关闭 Body，这里是使用 http 标准库时很容易忽略的点，requests 帮助做了这件事

	validators := rb.validators // 在 handler 执行前先跑一遍全部 validators，如果没提供的话就只跑 DefaultValidator，在其中会校验状态码
	if len(validators) == 0 {
		validators = []ResponseHandler{DefaultValidator}
	}
	if err = ChainHandlers(validators...)(res); err != nil {
		return err
	}
  
	h := consumeBody // 默认使用 consumeBody 作为响应体的 handler，这个方法只是用来消费 body 中的内容但不做任何处理，可以通过 Builder 提供其他的 handler 来处理响应体
	if rb.handler != nil {
		h = rb.handler
	}
	if err = h(res); err != nil {
		return err
	}
	return nil
}
```

可以看到，在整个发送请求的过程中，Builder 上定义的 getBody、validators、handler 是非常关键的，它们描述了如何发送请求体与如何处理响应，而这正是一个复杂 http 请求中需要处理的事情。requests 提供了一些 helper 函数来处理一些常见的场景。



## 2.2. BodyGetter

getBody 的类型是 BodyGetter，它的具体定义为 `type BodyGetter = func() (io.ReadCloser, error)`，预期最终会返回一个 `io.ReadCloser`，这个返回值在 `Request` 方法中会作为 `http.NewRequestWithContext` 的 body 参数。

所以为了传递一个具体的 body，我们可以自己实现一个 BodyGetter 函数，然后在构造请求时通过 `Builder.Body` 函数传递给 requests，但多数场景下我们可以直接使用 requests 封装好的一些 BodyGetter，这些方法在 `Builder` 结构上分别有对应的 shortcut，内部的实现很简单，都是用内置的 BodyGetter 作为参数调用 `Builder.Body`，并按需设置请求头中的内容：

```go
// 直接赋值 getBody，不判断是否已经有值，所以重复调用时以最后一次调用为准
func (rb *Builder) Body(src BodyGetter) *Builder {
	rb.getBody = src
	return rb
}

// 从 reader 中获取请求体
func (rb *Builder) BodyReader(r io.Reader) *Builder {
	return rb.Body(BodyReader(r))
}

// 提供一个向 writer 中写入内容的函数，writer 由 requests 注入，写入的内容会收集到一个 reader 中，然后从这个 reader 中获取请求体
func (rb *Builder) BodyWriter(f func(w io.Writer) error) *Builder {
	return rb.Body(BodyWriter(f))
}

// 从字节切片中获取请求体
func (rb *Builder) BodyBytes(b []byte) *Builder {
	return rb.Body(BodyBytes(b))
}

// 将结构体序列化成 json 字符串作为请求体，并设置请求头中的 content-type
func (rb *Builder) BodyJSON(v interface{}) *Builder {
	return rb.
		Body(BodyJSON(v)).
		ContentType("application/json")
}

// 将 url.Values 整合成表单请求的请求体，并设置请求头中的 content-type
func (rb *Builder) BodyForm(data url.Values) *Builder {
	return rb.
		Body(BodyForm(data)).
		ContentType("application/x-www-form-urlencoded")
}
```

由于 `Builder.Body` 并不会检查 `Builder.getBody` 是否已经有值，所以如果在一次链式调用中重复调用多个设置请求体的方法，那么最终会以最后一次为准。

从上面的代码可以看到，设置请求体的核心逻辑不在 Builder 的方法中，而是各个方法中传递给 `Builder.Body` 的函数，这些函数可以从入参获取 BodyGetter，具体来说有如下几个：

```go
// BodyReader 直接将入参的 Reader 封装一下返回，因为 BodyGetter 的定义就是要一个 ReadCloser
func BodyReader(r io.Reader) BodyGetter {
	return func() (io.ReadCloser, error) {
    // 如果本身就是 ReadCloser，那么直接返回
		if rc, ok := r.(io.ReadCloser); ok {
			return rc, nil
		}
    // 否则套一层 NopCloser，这个方法返回一个 nopCloser 结构，拥有一个空的 Close 方法
		return io.NopCloser(r), nil
	}
}

// BodyWriter 接收一个入参为 Writer 的函数，Writer 由 requests 注入，函数直接向 Writer 中写入内容，这些内容会被另一侧的 Reader 获取到
func BodyWriter(f func(w io.Writer) error) BodyGetter {
	return func() (io.ReadCloser, error) {
    // Pipe 返回一个 Writer 和 Reader，向 Writer 中写入内容能在 Reader 中读到
		r, w := io.Pipe()
    // 另起一个 goroutine，让 Writer 的写入和 Reader 的读取能同时进行
		go func() {
			var err error
			defer func() {
				w.CloseWithError(err)
			}()
			err = f(w)
		}()
    // 将 Reader 返回出去，供 http 标准库消费
		return r, nil
	}
}

// BodyBytes 将一个 []byte 结构包装成 ReadCloser
func BodyBytes(b []byte) BodyGetter {
	return func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(b)), nil
	}
}

// BodyJSON 将某个结构 marshal 为 json 字节序列，然后用 NopCloser 包装后返回
func BodyJSON(v interface{}) BodyGetter {
	return func() (io.ReadCloser, error) {
		b, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		return io.NopCloser(bytes.NewReader(b)), nil
	}
}

// BodyForm 处理 application/x-www-form-urlencoded 类的请求体，包装后返回
func BodyForm(data url.Values) BodyGetter {
	return func() (r io.ReadCloser, err error) {
		return io.NopCloser(strings.NewReader(data.Encode())), nil
	}
}
```



## 2.3. ResponseHandler

在 requests 中，validators 和处理请求的 handler 都是 ResponseHandler 类型，这个结构的类型定义为 `type ResponseHandler = func(*http.Response) error`，意图也非常明显，就是拿到一个 Response 的指针后对齐做一些处理，如果期间遇到错误就通过返回值抛出。通过这样的函数，requests 允许用户灵活地校验和处理响应体，来适配不同的业务场景。

先说 validators，顾名思义，它的作用是对某个 http 请求返回的内容做一些校验。我们可以通过 `Builder.AddValidator` 为某个请求加入所需的 validator，这个方法在 `Builder.validators` 列表中加入一个 ResponseHandler。我们在前面的 `Builder.Do` 方法中可以看到，在为某个响应执行 handler 之前会先跑一遍所有的 validator，当且仅当全部的 validator 都返回 nil 时才会进一步调用 handler。

而如果没有调用过 AddValidator，那么 validators 列表中就是空的，此时 requests 会默认执行 DefaultValidator，它的定义为：

```go
var DefaultValidator ResponseHandler = CheckStatus(
	http.StatusOK,
	http.StatusCreated,
	http.StatusAccepted,
	http.StatusNonAuthoritativeInfo,
	http.StatusNoContent,
)
```

进一步来看 CheckStatus 这个函数，它的定义如下：

```go
func CheckStatus(acceptStatuses ...int) ResponseHandler {
	return func(res *http.Response) error {
		for _, code := range acceptStatuses {
			if res.StatusCode == code {
				return nil
			}
		}

		return fmt.Errorf("%w: unexpected status: %d",
			(*ResponseError)(res), res.StatusCode)
	}
}
```

具体来说，CheckStatus 接收一批 http 状态码作为白名单，当且仅当 Response 中的状态码在这个白名单中时才返回 nil，否则返回一个 error 让 `Builder.Do` 方法提前返回。除此之外，requests 中还提供 CheckContentType 和 CheckPeek 两种 helper 方法，前者检查响应头中的 content-type 是否在白名单中，后者接收一个函数用来检查响应体的前 n 个字节。

所有的 validators 都通过后，`Builder.Do` 会执行定义在 Builder 上的 handler 方法，我们可以通过调用 `Builder.Handle` 方法来设置。如果没有调用过，那么 requests 会默认执行 consumeBody 方法，这个方法的定义如下：

```go
func consumeBody(res *http.Response) (err error) {
	const maxDiscardSize = 640 * 1 << 10 // 最多读这么多字节，读完直接丢弃掉
	if _, err = io.CopyN(io.Discard, res.Body, maxDiscardSize); err == io.EOF {
		err = nil
	}
	return err
}
```

除此之外，和 BodyGetter 一样，requests 为 handler 也提供了很多内置方法，这些方法在 Builder 上也有对应的 shortcut，具体如下：

```go
// ToJSON 将响应体 unmarshal 到入参的 v 中
func (rb *Builder) ToJSON(v interface{}) *Builder {
	return rb.Handle(ToJSON(v))
}

// ToString 将响应体的内容放到 sp 指向的字符串中
func (rb *Builder) ToString(sp *string) *Builder {
	return rb.Handle(ToString(sp))
}

// ToBytesBuffer 将响应体的内容放到入参的 Buffer 中
func (rb *Builder) ToBytesBuffer(buf *bytes.Buffer) *Builder {
	return rb.Handle(ToBytesBuffer(buf))
}

// ToWriter 将响应体内容 copy 到入参的 Writer 中，一个最常用的 Writer 就是 os.Stdout
func (rb *Builder) ToWriter(w io.Writer) *Builder {
	return rb.Handle(ToWriter(w))
}
```

而这些 shortcut 内部的 ToXXX 的代码如下：

```go
func ToJSON(v interface{}) ResponseHandler {
	return func(res *http.Response) error {
    // 读出所有的内容放到 data 中
		data, err := io.ReadAll(res.Body)
		if err != nil {
			return err
		}
    // 将 data unmarshal 到 v 对应的结构中
		if err = json.Unmarshal(data, v); err != nil {
			return err
		}
		return nil
	}
}

func ToString(sp *string) ResponseHandler {
	return func(res *http.Response) error {
    // 将 Body 直接 copy 到 strings.Builder 中
		var buf strings.Builder
		_, err := io.Copy(&buf, res.Body)
		if err == nil {
			*sp = buf.String()
		}
    // 将复制的内容通过 String 整合成 string 结构写入 sp 指向的内存中，所以 sp 不能为 nil
		return err
	}
}

func ToBytesBuffer(buf *bytes.Buffer) ResponseHandler {
	return func(res *http.Response) error {
    // 直接复制
		_, err := io.Copy(buf, res.Body)
		return err
	}
}

func ToWriter(w io.Writer) ResponseHandler {
	return ToBufioReader(func(r *bufio.Reader) error {
    // 直接复制
		_, err := io.Copy(w, r)
		return err
	})
}
```

除此之外，requests 还提供了 ToBufioReader 和 ToBufioScanner，这两者分别接受入参为 `*bufio.Reader` 和 `*bufio.Scanner` 的函数，可以从被 requests 注入的入参中持续地读取内容，这对于响应体非常大的请求是非常友好的。



## 2.4. 其他

除此之外，requests 还允许使用方在 Builder 中设置自定义的 `http.Client`，这个结构体可以通过配置内部字段而调整请求的处理流程（RoundTripper），requests 为此还封装了一些常用的 helper 函数，从而让它具备更高的普适性，这部分就不展开说明了，感兴趣的朋友可以自行阅读相关代码（redirects.go、recorder.go、transport.go）。
