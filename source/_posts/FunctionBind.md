---
title: 函数 Function.prototype.bind 的几个场景
date: 2020-08-04 09:54:30
categories: 前端
description: 内容包括：场景的具体内容
---

# 0x0 前言

一直以来都没想到 [bind](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Function/bind) 函数的具体应用场景，最近读某源码时偶然在一个类声明中看到了下面第一个场景中的代码，由此联想到了一些其他内容，这里记录一下

# 0x1 第一个场景

相关的核心代码如下

```javascript
// 类名为 Directive
this._update = function (val) {
  this.update(val) //该方法同样被定义在该类中，用于更新属性，这里因篇幅原因不给出
}.bind(this)
```

该方法在这个类之后的代码中被作为回调函数传给了另一个 Watcher 对象，代码如下

```javascript
var watcher = this._watcher = new Watcher(..., this._update)
```

这个 Watcher 对象**将 _update 函数作为一个属性保存在了自己的作用域**中，并在用户触发相应的事件后执行回调。

这个场景下的本意是 Watcher 在监测到事件发生后调用 Directive._update 方法来更新对应的 Directive 实例中的属性，然而我们知道，Javascript 中的 this 是会根据上下文进行变化的，当 Watcher 把 _update 作为自己的属性时，这个 this 就从 Directive 变成 Watcher 了，之后的更新也都会发生在 Watcher 中，这显然偏离了本意。

而 bind 的作用在于，它强制绑定了代码中 this 的值，使这个函数在赋值给其他对象作为属性且通过该对象进行调用时依然以 bind 中的参数作为 this ，在这里就达到了场景本身的需求。

# 0x2 第二个场景

上面的例子并不是一个经常会遇到的场景，下面给出一个更普遍一些的情况：假设我们在视图中有一系列按钮通过绑定事件来操作一个 Object 中的属性，由于在 js 的逻辑中也有可能用到同样的属性操作，所以这些操作可以作为该对象的方法，然后将该方法作为回调函数传给对应的 Listener ，代码大概如下

```javascript
// 这段代码因为没有具体上下文所以可能显得有些刻意，不过足够说明问题本身了
let runTime = new (function() {
  this.data = 0
  this.addData = function() {
    this.data++;
  }
})();

let btn = document.querySelector('#btn-addData');
btn.onclick = runTime.addData;
```

这里试图在点击一个按钮后将 runTime.data 自增，在将回调函数绑定到 click 事件时使用了 `btn.onclick = runTime.addData` 这样的语句，然而需要注意的是，在绑定后，addData 中的 this 就不再是 runTime ，而是 btn 了，这样在点击后就会尝试递增 btn.data ，从而偏离了本意。

正确的做法和前面的例子一样，应该在 addData 的函数定义后加入 `.bind(this)` 语句，从而将 this 强制绑定为 runTime 对象。

# 0x3 第三个场景

另外上面给出的 MDN 的[链接](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Function/b)中也有几个场景，不过我认为其中受用面最大的应该是 “快捷调用” 的场景，这里为了查阅方便来转述一下

场景的意图在于给经常调用的长对象方法提供一个捷径，比如想通过 Array.prototype.slice 来将一个类数组对象转换为真正的数组时，常规写法可能是

```javascript
var slice = Array.prototype.slice
...
slice.apply(arguments)
```

但是当这个函数需要经常被调用时，slice.apply 的写法还是有些令人厌烦，这时可以利用 bind 来将 apply 的 this 绑定为 Array.prototype.slice（这个 this 指的是 “apply 作为谁的方法被调用” 中的 “谁” 而不是 apply 的第一个参数），从而通过直接调用绑定后的函数（包装函数）来达到目的，代码如下

```javascript
var slice = Function.prototype.apply.bind(Array.prototype.slice)
...
slice(arguments)
```

这样就缩短了调用方法时所需的长前缀，写起来就能更愉快一些。