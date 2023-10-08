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

TBD



## 2.2. recorder

TBD



## 2.3. redirects

TBD



## 2.4. transport

TBD
