---
title: CallBack 与 Promise 与 Generator 与 async/await 的故事
date: 2020-09-29 20:58:40
categories: 前端
---

# 0x0 前言

之前在读 express 相关的项目时经常看到 async/await 关键字，所以就跑去查了一下[文档](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)，看完以后还是觉得云里雾里；前几天偶然看到阮一峰老师的一篇[文章](http://caibaojian.com/es6/async.html)，文章中整理了当前 Javascript 处理异步的一些方式，并作了一些对比，尤其最后在提到 async/await 时使用 Generator 去模拟其行为，顿时觉得茅塞顿开。

于是这篇文章就作为一个简单的总结+个人的一些理解，就这样开始写下去了。

# 0x1 关于 Javascript 的异步

之前有看到所谓 “异步就是多线程” 的言论，但是在上文提到的文章中，作者把异步看作是一种可以在两个任务中互相切换（并传递信息）的一种模式（这里的任务指按顺序执行的一段序列），那么根据这个思想，其实 Generator 的模式就可以看作是一种异步，于是它在配合 Javascript 的事件循环（Event Loop）后就可以做到一些奇妙的效果，详见下文。

众所周知，Javascript 是一门单线程的语言，这句话多少都令人有些疑惑（或者可能单纯是我比较愚钝），比如像 NodeJS 的 fs.readFile ，在 CallBack 被调用前，这个 “唯一” 的线程难道还是要自己去与文件系统交互吗；或者对于 setTimeout ，这个 “唯一” 的线程难道会通过在用户的代码中插入轮询来进行计时吗。

事实上，这里所谓的单线程指的是用户代码所在的线程（这里姑且称之为主线程），而对于计时器、文件读取这类的操作，Javascript 依然有相应的线程来完成这些任务。也就是说，用户的代码并不能进入到这些线程中来执行，但是可以通过 API 来委托它们执行任务，那么就需要一种方式，使得这些线程在执行完相应的任务后能通知到主线程，对于这种方式，首先能想到的就是 CallBack。

# 0x2 关于 CallBack

CallBack 并不是专门用来解决异步问题的，它只是一个被作为参数传递给另一个函数的函数，这样看来其实像 Decorator 这种的都可以算作是一种 CallBack。

回到异步的话题上，在 Javascript 的一种异步模式中，CallBack 用于告知对应的任务线程，在执行完主线程分发的任务后调用之，从而让执行流回到主线程中。比如前文所述的 readFile，对应的代码大概如下:

```javascript
const { readFile } = require('fs')
readFile(..., (err, data) => {
  ...
})
```

这里 readFile 的第二个参数就是一个 CallBack，它委托与文件系统交互的线程去读取由第一个参数指明的文件。在它执行任务的期间，有可能成功也有可能失败，所以 NodeJs 大部分的 CallBack 的第一个参数都用来记录错误，后面的则用来处理成功后获取到的数据，在我看来这是一个非常优雅的模式，它并没有什么心智负担，写起来非常自然。

但是一旦异步的操作有了前后的顺序依赖，事情就变得不尽人意了，鼎鼎大名的回调地狱（CallBack Hell）就是由此产生的，还是之前读文件的例子，比如业务一定要按照 `file1 -> file2 -> file3 -> ...` 这样的顺序来进行的话，那么回调就会一层套用一层，最终的结果是代码变得横向发展，这是十分不美观且难以维护的状态。

于是 Promise 出现了。

# 0x3 关于 Promise

Promise 其实是一种新的回调模式，网络上有大量相关的 polyfill，看一下代码就可以明白内部的基本原理（这里特别推荐一下 [yaku](https://github.com/ysmood/yaku) 这个库，贺老曾对此有过很高的评价）。

这里额外说明一件事，就是虽然 Promise 在大部分的实现里都以微任务来执行，但是标准中并没有提及这件事，以至于我见过的 polyfill 基本都是用 setTimeout 来模拟的，所以在写业务的时候其实不能过分依赖这一点。

回到上面的异步顺序依赖的问题，对于那种逻辑，如果用 CallBack 来写的话，大概是这个样子:

```javascript
const { readFile } = require('fs')

readFile('file1', (err, data) => {
  if (err) {
    ...
  }
  console.log(`File1 content: ${data}`)
  readFile('file2', (err, data) => {
    if (err) {
      ...
    }
    console.log(`File2 content: ${data}`)
    readFile('file3', (err, data) => {
      if (err) {
        ...
      }
      console.log(`File3 content: ${data}`)
      readFile('...', (err, data) => {
        ...
      })
    })
  })
})
```

这里仅仅读取了三个文件，代码的缩进就已经到了很深的程度了，而且冗余性特别大，尽管对于这个样例，错误处理的逻辑可能是完全一样的，每个回调对应的错误还是要分别处理。

而同样的逻辑，如果用 Promise 写出来是这样的:

```javascript
const { readFile } = require('fs').promises

readFile('file1', { encoding: 'utf8' })
.then(data => {
  console.log(`File1 content: ${data}`)
  return readFile('file2', { encoding: 'utf8' })
})
.then(data => {
  console.log(`File2 content: ${data}`)
  return readFile('file3', { encoding: 'utf8' })
})
.then(data => {
  console.log(`File3 content: ${data}`)
})
.catch(err => {
  ...
})
```

可以看到，Promise 很优雅地解决了上面说的两个问题，拯救被回调地狱折磨的前辈们于水火之中。

# 0x4 更进一步

虽然 Promise 很优雅，可以很好地解决上面提到的问题，但是一个是因为程序员比较懒，一个是因为 Promise 写多了确实有点烦，所以大家就又开始找新的解决顺序依赖的方式。

先说为什么比较烦，上面的例子因为逻辑很简单，而且只有三个显式的顺序依赖所以可能不太明显，但是想象一下如果顺序很多，那么代码里基本上全是 then then then，一个是放眼望去基本看不出主要的逻辑，另一个是...顺序依赖其实是一个挺大众的需求，如果有一个语法糖能提供更好的支持，那真的是一件令人高兴的事情。

于是我们的主角就出场了，它叫 await ，平时只喜欢和 async 待在一起，对于具体的用法稍稍 STFW 一下就有很多，所以我比较想从 Generator + Promise 的角度来描写它，那么下面就先来说一下 Generator。

# 0x5 关于 Generator

Generator 这个概念（机制）也不是 Js 这门语言独有的，比如 Python 中就有同样的机制。在 Js 中，一个 Generator 是一个带星号的函数，内部可以通过 yield 关键字来“送出”和“接收”数据，它大概长下面的样子，这里就不详细介绍它了，具体的机制可以看相关的[文档](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator)。

```javascript
function *ImaGenerator () {
  const data = yield "Send data from generator"
  console.log("Get data from main:", data)
}

const gen = ImaGenerator()

console.log("Get data from generator:", gen.next().value)
gen.next("Send data from main")
```

可能是由于代码量比较少，平时写的时候还没用实际到过这项技术，不过我还是比较感谢曾经学习了它的自己，让我能够借助它来更好地理解 async/await。

前面说过，异步可以被理解成是一种在两个顺序流程之间切换并传递信息的运行模式，那么如果把这个思想落实到 Generator 上就可以发现，yield 关键字既可以让流程从 Generator 中切换到外部执行流，又可以携带特定的信息；next 方法在另一方面使得流程回到 Generator 中成为可能。

于是，通过观察前面 CallBack 和 Promise 阅读文件的例子，就可以发现其具备特定的规律，从而结合 Generator 写出如下的代码：

```javascript
// callback + generator 的例子
function Thunkify (fn) {
  return function argExceptCb (...args) {
    return function argIncludeCb (cb) {
      fn.call(fn, ...args, cb)
    }
  }
}

const fs = require('fs')
const readFile = Thunkify(fs.readFile)

function *readFiles (...filenames) {
  for (fn of filenames) {
    const content = yield readFile(fn)
    console.log(content)
  }
}

function runThunkifyGen (gen) {

  function next (err, data) {
    const ret = gen.next(data)    
    if (ret.done) return
    ret.value(next)
  }

  next()
}

runThunkifyGen(readFiles('file1', 'file2', 'file3'))

console.log('Read done')
```

```javascript
// promise + generator 的例子
const { readFile } = require('fs').promises

function autorun (gen) {
  (function next (data) {
    const ret = gen.next(data)
    if (ret.done) return
    ret.value.then(data => next(data.toString()))
  })()
}

function *readFiles (...filenames) {
  for (fn of filenames) {
    const content = yield readFile(fn)
    console.log(content)
  }
}

autorun(readFiles('file1', 'file2', 'file3'))

console.log("Read done")
```

例子中的 autorun 和 runThunkifyGen 函数被称为 **执行器**，用于自动将流程在 Generator 和调用方之间切换，并保证读取的文件顺序。

可以看到，实际上执行器就是提取出了 callback 和 then 的部分，在这里用户需要关注的只有 readFiles 这一个函数，而两个例子中，readFiles 长得一模一样。

那么如果我们把目光着眼于更一般的场景，是否可以结合 Generator 和执行器来让其达到普适呢？答案是可以的，下面给出代码：

```javascript
function async (fn) {

	function step (gen, data) {
		try {
			var next = gen.next(data)
		} catch (err) {
			return Promise.reject(err)
		}
		return next.done
      ? Promise.resolve(next.value)
      : Promise.resolve(next.value)
      .then(data => step(gen, data))
	}

	return function () {
		const gen = fn()
		return step(gen)
	}
}
```

async 函数接受一个 Generator，然后返回一个新的函数，这个函数在内部递归调用 step，这个 step 其实就是执行器（其实可以通过 IIFE 使得 step 变成单例，不过这里就不考虑这些了）。

和上面不同的地方在于，前面的两个都分别假定了 yield 后面跟随的要么是一个 thunk，要么是一个promise，而 async 则支持 yield 后面跟随一般值，能做到这一点的原因在于 Promise.resolve 和 Promise.reject ，其具体的机制可以查看MDN。

那么该如何使用 async 呢，继续回到之前按顺序打开并读取文件的例子，我们的代码会变成这样：

```javascript
const { readFile } = require('fs').promises 
const func1 = async(function *() {
	const data1 = yield readFile('file1')
	const data2 = yield readFile('file2')
  const data3 = yield readFile('file3')

	console.log('data1:', data1.toString())
	console.log('data2:', data2.toString())
  console.log('data3:', data3.toString())
})
```

已经对 async/await 有所了解的小伙伴可以发现，同样的逻辑，如果使用这一对新人，则代码会变成这样：

```javascript
const { readFile } = require('fs').promises
const func2 = async function() {
	const data1 = await readFile('file1')
	const data2 = await readFile('file2')
  const data3 = await readFile('file3')

	console.log('data1:', data1.toString())
	console.log('data2:', data2.toString())
  console.log('data3:', data3.toString())
}
```

很相似，对吧？

