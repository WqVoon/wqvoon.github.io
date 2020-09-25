---
title: 一个关于 script 标签的 type 属性的另类用法
date: 2020-09-25 21:33:18
categories: 前端
---

# 0x00 前言

今天出于好奇跑去 React 官网转了一圈，看到里面提供了一个 [无需构建工具](https://raw.githubusercontent.com/reactjs/reactjs.org/master/static/html/single-file-example.html) 的体验例子，看到代码后感觉很神奇，因为它直接在 script 里的 render 函数中写入了 JSX ，并且成功渲染到了视图里，但是这种语法显然不是被允许的，红色的 `Uncaught SyntaxError: expected expression, got '<'` 是应该出现在 console 中的。

# 0x01 原理及实现

思来想去，突然发现 script 中的 type 标签里并不是常规的 text/javascript ，而是非标准的 text/babel ，那么这个东西有什么影响呢？

其实把这段代码复制到一个带语法高亮的编辑器中应该就能看到异样了，比如扔进我本地使用的 vscode 时就可以发现，script 标签中并没有提供语法高亮和代码补全功能。

STFW 后得知，对于这种 type ，浏览器不会将其看作将被执行的 script ，而是当作普通的标签元素来看待，而既然这里的 type 是 babel，上面的 script:src 也引入了 babel ，那么想来编译并执行这段纯文本就是它的工作了。

知道了这个原理后，就可以写出简单的渲染方法了，代码如下：

```html
<!-- HTML 文件 -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Render-Test</title>
  <script src="render.js"></script>
</head>
<body>
  <div id="app"></div>
  
  <script type="text/react">
    console.log("Output msg to console")

    render(

      <div>
        <h1>Hello, React!</h1>
        <spanInputBox</span> <input type="text">
        <button onclick="alert('Hello!')">clickMe</button>
      </div>,

      document.getElementById('app')

    )
  </script>
</body>
</html>
```

render.js 文件内容如下：

```javascript
window.onload = function () {
  const pattern = /\s*render\s*\(\s*(<.+>)/gs

  const scriptList = document.querySelectorAll('script[type="text/react"]')

  globalThis.render = function (template, node) {
    node.innerHTML = template
  }

  for (let script of scriptList) {
    eval(script.textContent.replaceAll(
      pattern,
      (_, template) => `;render(\`${template}\``       
    ))
  }

}
```

大概思路就是找到所有 type 相符的 script 标签，给 jsx 的部分加上引号，然后把整坨内容扔进 eval 里跑一下，当然现实中肯定不会这么简单粗暴，这里只能说是一个 POC 吧。

# 0x02 总结

没什么总结的，就是闲着没事水了一篇博客而已（