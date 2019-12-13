---
title: 记一段 Js 代码的解读与思考
date: 2019-12-11 16:30:23
categories: 前端
description: 内容包括：前言+相关问题+结语
---

# 0x0 前言

最近逛别人博客的时候，偶然看到了下面这货：
> <div id="yuren-content"></div>

立刻就被这个简约的小东西给吸引住了，于是对着它就是一发审查元素，想看看其具体的实现，在把主要的部分提取出来后得到如下内容：

```html
<!DOCTYPE html>
<html>
<head>
    <title>Test</title>
    <meta charset="utf8">
</head>
<body>
 	<div id="binft"></div>
  <script>
    var binft=function(e){function m(a){for(var d=document.createDocumentFragment(),c=0;a>c;c++){var b=document.createElement("span");b.textContent=String.fromCharCode(94*Math.random()+33);b.style.color=f[Math.floor(Math.random()*f.length)];d.appendChild(b)}return d}function g(){var d=h[a.skillI];a.step?a.step--:(a.step=k,a.prefixP<b.length?(0<=a.prefixP&&(a.text+=b[a.prefixP]),a.prefixP++):"forward"===a.direction?a.skillP<d.length?(a.text+=d[a.skillP],a.skillP++):a.delay?a.delay--:(a.direction="backward",
a.delay=l):0<a.skillP?(a.text=a.text.slice(0,-1),a.skillP--):(a.skillI=(a.skillI+1)%h.length,a.direction="forward"));e.textContent=a.text;e.appendChild(m(a.prefixP<b.length?Math.min(c,c+a.prefixP):Math.min(c,d.length-a.skillP)));setTimeout(g,n)}var b="",h="\u9752\u9752\u9675\u4e0a\u67cf\uff0c\u78ca\u78ca\u6da7\u4e2d\u77f3\u3002 \u4eba\u751f\u5929\u5730\u95f4\uff0c\u5ffd\u5982\u8fdc\u884c\u5ba2\u3002 \u6597\u9152\u76f8\u5a31\u4e50\uff0c\u804a\u539a\u4e0d\u4e3a\u8584\u3002 \u9a71\u8f66\u7b56\u9a7d\u9a6c\uff0c\u6e38\u620f\u5b9b\u4e0e\u6d1b\u3002 \u6d1b\u4e2d\u4f55\u90c1\u90c1\uff0c\u51a0\u5e26\u81ea\u76f8\u7d22\u3002 \u957f\u8862\u7f57\u5939\u5df7\uff0c\u738b\u4faf\u591a\u7b2c\u5b85\u3002 \u4e24\u5bab\u9065\u76f8\u671b\uff0c\u53cc\u9619\u767e\u4f59\u5c3a\u3002 \u6781\u5bb4\u5a31\u5fc3\u610f\uff0c\u621a\u621a\u4f55\u6240\u8feb\uff1f".split(" ").map(function(a){return a+
""}),l=2,k=1,c=5,n=75,f="rgb(110,64,170) rgb(150,61,179) rgb(191,60,175) rgb(228,65,157) rgb(254,75,131) rgb(255,94,99) rgb(255,120,71) rgb(251,150,51) rgb(226,183,47) rgb(198,214,60) rgb(175,240,91) rgb(127,246,88) rgb(82,246,103) rgb(48,239,130) rgb(29,223,163) rgb(26,199,194) rgb(35,171,216) rgb(54,140,225) rgb(76,110,219) rgb(96,84,200)".split(" "),a={text:"",prefixP:-c,skillI:0,skillP:0,direction:"forward",delay:l,step:k};g()};binft(document.getElementById('binft'));
  </script>
</body>
```

其中 js 的部分经历了压缩，随便找了个在线解压工具尝试格式化后，终于获得了一份勉强能看的代码。而由于最近刚刚了解了 js 混淆的含义与作用，这份代码又刚好经过了不太难的混淆处理，故准备拿它开刀，尝试自己分析一下。

# 0x1 相关问题

## 0x10 恼人的条件表达式

首先比较麻烦的就是

```javascript
a.step ? a.step--:(a.step = k, a.prefixP < b.length ? (0 <= a.prefixP && (a.text += b[a.prefixP]), a.prefixP++) : "forward" === a.direction ? a.skillP < d.length ? (a.text += d[a.skillP], a.skillP++) : a.delay ? a.delay--:(a.direction = "backward", a.delay = l) : 0 < a.skillP ? (a.text = a.text.slice(0, -1), a.skillP--) : (a.skillI = (a.skillI + 1) % h.length, a.direction = "forward"))
```

这一坨迷之表达式了，对我而言非常有必要将其转换成普通的 if-else 语句，于是尝试 STFW 后得到如下三只：

- [OpenGG 的 转换工具(会转成 IIFE)](https://opengg.github.io/babel-plugin-transform-ternary-to-if-else/)
- [raybb 的 转换工具(需要用空格分隔关键字)](https://raybb.github.io/ternary-converter/)
- [website-dev.eu 的转换工具(需要科学上网，或手动换源)](converter.website-dev.eu)

然而如上所述，三位前辈的工具都有着各自的问题，先抛开 IIFE 的可读性不说，后面两只并没有支持诸如  `1?(2?3:4,3?4:5):6` 这样的平行语句，因此并不能处理上面的表达式，考虑到未来可能还会有类似的需求，故以解决上述情况为主要目标，掏出 Python 一顿乱敲产出了如下脚本（TL;DR）：

```python
# 引号中输入想要处理的内容
tmp = ""

# 预处理 删除所有空格 方便后面判断左右是否有括号
tmp = tmp.replace(' ', '')
# 将一组语句在考虑括号的前提下以逗号再分组
def getSplitContent(tmp):
	balance = 0
	indexs = []
	words = []

	for i in range(len(tmp)):
		if tmp[i] == '(':
			balance += 1
		elif tmp[i] == ')':
			balance -= 1
		elif tmp[i]==',' and balance==0:
			indexs.append(i)
	# 手动切分 因为 str 是不可变对象 暂时没有好办法
	i = -1
	for j in indexs:
		words.append(tmp[i+1:j])
		i = j
	else:
		words.append(tmp[i+1:])

	return words

# 获得 tmp 中和 ? 匹配的 : 符号
def getIndex(tmp):
	balance = 0

	for i in range(len(tmp)):
		if tmp[i] == '?':
			balance += 1
		elif tmp[i] == ':':
			balance -= 1
			if balance == 0:
				return i
	else:
		return -1

def fun(input, n=0):
	if input.startswith('(') and input.endswith(')'):
		input = input[1:-1]

	tab = '  '*n
	splitTmp = getSplitContent(input)

	for tmp in splitTmp:

		# 没找到则说明当前语句不可再分
		left = tmp.find('?')
		if left == -1:
			print("%s%s;"%(tab, tmp))
			continue

		# 没找到则说明条件表达式不完整
		right = getIndex(tmp)
		if right == -1:
			print("Error")
			exit()
		# 打印当前层的 if-else 语句并递归处理子句
		print("%sif (%s) {"%(tab, tmp[:left]))

		fun(tmp[left+1:right], n+1)

		print('%s} else {'%tab)

		fun(tmp[right+1:], n+1)

		print('%s}'%tab)

fun(tmp)

```

主要思路比较简单，就是以括号为基准挑选出可作为分隔符的逗号，并以此对语句进行分组后再递归处理，唯一比较坑的地方是 python 中 str 属于不可变对象，因此这里只好采用记录下标并手动拆分的办法= =

同时，受上面前辈的启发，觉得可以在博客里开个 [杂项](/tools/) 的板块，里面放一些小脚本等与博客本身没什么关系的东西，这样既方便日后的使用，也可以作为一种练习，嗯，可喜可贺。

把上面的一坨表达式丢进脚本里，再用运行后的结果替换之，可以发现这个名为 **g** 的函数就是逻辑的主要部分了。

## 0x11 setTimeout 以及 js 事件循环机制

结束替换的工作后，就可以开始读代码了。考虑到实际的效果，能够猜到代码里包含着类似循环的部分，可是尝试搜索 for 和 while 时都没有找到任何内容。在仔细阅读后，终于发现在上面转换出来的 g 函数里静静地躺着一只 `setTimeout(g, n)` ，想来它就是我们的目标了。

可是很奇怪，之前在 w某school 和 某鸟 中了解到该函数只是设置一个表达式在多少毫秒后执行（因为没有实际用过我一直以为是像 sleep 一样的东西），那么如果把它放在这个地方，为什么不会因为无限递归而爆栈呢？

继续 STFW 后，终于得到[答案](https://juejin.im/post/59e85eebf265da430d571f89)，这里为了方便日后回忆以及防止链接挂掉，简单地总结一下：

- 首先要明确的，是 js 本身是一个 **单线程** 的语言，但是为了更好地处理网页中日渐庞大的静态资源，其提供了 同步任务 和 异步任务 两种机制。在实际执行时，同步任务进入主线程，而异步任务进入 EventTable 并注册回调函数，在指定的事情完成后，EventTable 会将这个函数移入 EventQueue；当 js 的 monitoring process 进程发现主线程空栈后就会去 EventQueue 中读取对应的函数并执行，这个过程一直持续到所有的任务被完成。

- 而除了广义的 同步 与 异步，在精细定义下任务还可以被分成 宏任务(macro-task) 和 微任务(micro-task) ，前者包括整体代码，setTimeout，setInterval，后者包括 Promise，process.nextTick 等等；不同的任务在执行时会以这两种任务为基准进入对应的 EventQueue ，并交替运行直至所有任务被完成。

- 而 setTimeout 函数中用来表示时间的参数，实际上指的是经过多少毫秒后将任务从 EventTable 转移到宏任务的 EventQueue 中，所以影响实际时间的因素其实还挺多的，完全不是 w某school 和 某鸟 中说的那样= =

据说这一点在前端的面试题中屡见不鲜，以后有时间可以找一找相关的内容。

回到正题，由于这里把函数调用放到了所有语句的最后，所以时间上基本没什么偏差；而之所以以这种方式实现，是因为 js 本事是单线程的语言，所以如果这里以普通循环来实现的话会让其他的任务卡住，看来 **这里异步的递归就是循环** 呀，嗯，学到了。

## 0x12 createDocumentFragment 的含义

从最终效果来看，这是一个不断更新文档元素的过程，通过查看代码可以发现，实际负责插入随机字符的是名为 m 的这个函数，注意到在其 for 循环中，有着名为 createDocumentFragment 的函数调用，这就又触及到我的盲区了，遂继续[求助网络](https://developer.mozilla.org/en-US/docs/Web/API/Document/createDocumentFragment)，得知该函数可以很好地工作在频繁更新元素的环境下。

# 0x2 结语

做好上述准备后，就可以安心地读代码了。其本身并没有什么难度，在去掉了用来混淆的无关代码以及对变量和函数进行语义化后就得到了当前页面中使用的 js 代码了。有兴趣的朋友们可以看一下～

<script>
// 作为 web 坑的新人，非常渴望找到一个可以交流技术或可以一起合作写项目的个人或
// 团体，如果您对此有兴趣的话，非常欢迎通过右侧的联系方式与我交流～
	(()=>{
		let div = document.querySelector('#yuren-content');
		let sequences = ["一二三四五，上山打老虎。", "老虎没打到，打到小松鼠。"];
		let colors = ["rgb(110,64,170)", "rgb(150,61,179)", "rgb(191,60,175)", "rgb(228,65,157)", "rgb(254,75,131)", "rgb(255,94,99)", "rgb(255,120,71)", "rgb(251,150,51)", "rgb(226,183,47)", "rgb(198,214,60)", "rgb(175,240,91)", "rgb(127,246,88)", "rgb(82,246,103)", "rgb(48,239,130)", "rgb(29,223,163)", "rgb(26,199,194)", "rgb(35,171,216)", "rgb(54,140,225)", "rgb(76,110,219)", "rgb(96,84,200)"];



		function getOneColor() {
			return colors[Math.floor(Math.random()*colors.length)];
		}
		
		function getSomeChar(r) {
			let n=document.createDocumentFragment();
			for (let i=0; i<r; ++i) {
				let l = document.createElement('span');
				l.textContent = String.fromCharCode(33+94*Math.random());
				l.style.color = getOneColor();
	
				n.appendChild(l);
			}
			return n;
		}
	
		let tmp = "";
		let index = 0;
		let which = 0;
		let delay = 2;
		let stop = true;
		let direction = "forward";
	
		function run() {
			let seq = sequences[which];
			if (stop) {
				stop = false;
			} else {
				stop = true;
				if (direction === "forward") {
					if (index < seq.length) {
						tmp += seq[index];
						++index;
					} else {
						if (delay) {
							--delay;
						} else {
							direction = 'backward';
							delay = 2;
						}
					}
				} else {
					if (index > 0) {
						tmp = tmp.slice(0, -1);
						--index;
					} else {
						which = (which+1)%sequences.length;
						direction = 'forward';
					}
				}
			}
			div.textContent = tmp;
			div.appendChild(getSomeChar(Math.min(5, seq.length-index)));
			setTimeout(run, 75);
		}
		run();
	})();
</script>