---
title: 三元表达式转if-else语句
sidebar: []
cover: false
---
<style>
	.tex {
		width: 100%;
		height:200px;
		overflow: 100%;
		border-radius: 5px;
	}

	.btn {
		text-align: center;
		width: 100%;
		height: 30px;
		font-size: 100%;
		background-color: rgb(100,200,255);
		color: rgb(255,255,255);
		border-radius: 5px;
	}
</style>
- 转换时的分隔符为 ? 与 : 两个符号，请确保两者不会出现在诸如字符串一类的特殊地方
- 转换时以小括号作为分组依据，故无法处理一对括号外侧带有无关字符的情况 
- 若在使用中遇到什么问题或您有什么好的建议，欢迎[和我交流](mailto:2027195958@qq.com)

<textarea class="tex" id="tex" placeholder="请输入条件表达式"></textarea>
<button class="btn">Translate</button>
<textarea class="tex" id="rlt" placeholder="这里将输出结果哦"></textarea>
<script>
	tex = document.querySelector('#tex');
	btn = document.querySelector('.btn');
	rlt = document.querySelector('#rlt');

	btn.onclick = ()=>{
		rlt.focus();
		let tmp = tex.value.split(' ').join('');
		rlt.value = '';
		function getSplitContent(tmp) {
			let balance = 0;
			let indexs = [];
			let words = [];

			for (let i=0; i<tmp.length; ++i) {
				if (tmp[i] === '(')
					balance += 1;
				else if (tmp[i] === ')')
					balance -= 1;
				else if (tmp[i]===','&&balance===0)
					indexs.push(i);
			}

			let i = -1;
			for (let j=0; j<indexs.length; ++j) {
				words.push(tmp.slice(i+1, indexs[j]));
				i = indexs[j];
			}
			words.push(tmp.slice(i+1));

			return words
		}
		
		function getIndex(tmp) {
			let balance = 0;

			for (let i=0; i<tmp.length; ++i) {
				if (tmp[i] === '?') {
					balance += 1;
				} else if (tmp[i] === ':') {
					balance -= 1;
					if (balance === 0) return i;
				}

			}

			return -1;
		}

		function fun(input, n=0) {
			if (input.startsWith('(')&&input.endsWith(')'))
				input = input.slice(1, -1);

			let tab = '  '.repeat(n);
			let splitTmp = getSplitContent(input);

			for (let i=0; i<splitTmp.length; ++i) {
				let tmp = splitTmp[i];
				// alert(`${n} ${splitTmp}`);

				let left = tmp.indexOf('?');
				if (left === -1) {
					rlt.value += `${tab}${tmp};\n`;
					continue;
				}

				let right = getIndex(tmp);
				if (right === -1) {
					rlt.value = '';
					alert("语法有错误，转换出错啦！");
					return false;
				}

				rlt.value += `${tab}if (${tmp.slice(0,left)}) {\n`;
				fun(tmp.slice(left+1, right), n+1);

				rlt.value += `${tab}} else {\n`;

				fun(tmp.slice(right+1), n+1);

				rlt.value += `${tab}}\n`;
			}
		}

		fun(tmp);
	}
</script>

