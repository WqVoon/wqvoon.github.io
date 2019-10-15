---
title: 在 Docker for MacOS 中运行 GUI 程序
date: 2019-10-14 23:04:14
categories: Docker
---

内容包括：前言+环境+具体操作+原理



<!-- more -->



# 0x0 前言

在初步接触了 Docker 后，突然萌生了一个“可不可以在其中跑GUI程序的念头”，遂急忙STFW&&RTFM，并在查阅了相关的一些文档后，成功在本地运行了容器内的GUI测试程序，下面记录一下相关的工作和原理。

# 0x1 相关环境

```bash
Docker version 18.09.2
XQuartz 2.7.11（xorg-server 1.18.4)
```

以上软件均可通过 [homebrew](https://brew.sh) 进行安装

# 0x2 具体操作

1. XQuartz -> 偏好设置 -> 安全性 -> 勾选“允许从网络客户端连接” -> 退出程序；
2. 终端键入 ```xhost +```（注意两者之间的空格）重新启动 XQuartz；
3. 使用诸如 ```nmap``` 类的工具查看 6000 端口是否被 X11 服务占用，如果已经被占用即可继续下一步操作，如果没有被占用的话...因为没遇到过所以我也不知道怎么办:-P；
4. 在 run 或 exec 容器时加入```-e DISPLAY=host.docker.internal:0```参数，比如我这里通过对一个现有的，已经安装过 xarclock 时钟小程序的容器 toyOS 执行```docker exec -ite DISPLAY=host.docker.internal:0 toyOS /usr/bin/xarclock```，就会在我的本地出现一个小时钟的GUI程序；

# 0x3 相关原理

在 Linux 系统及一些 Unix-like 系统中，有着 [X Window System](http://linfo.org/x.html) 的概念（下面简称为 X系统），用户的 GUI 程序作为 X Client 向本地或远程的 X Server 交互，以得到底层的支持来在运行 X Server 的设备上绘制出图像，而 [XQuartz](https://www.xquartz.org) 则是一款面向 MacOS 系统的 X系统，（在我理解的层面上）也提供了如上的功能支持。

于是在这个原理的支撑下，**如何让 Docker 运行 GUI 程序** 这个问题就被转化成了 **如何在宿主机运行 X Server** 以及 **如何让 Docker 中的 X Client  与宿主机的 X Server 实现交互**，下面分别来解决这两个问题：

## 0x31 如何在宿主机运行 X Server

在 X系统的定义中可以看到，本身该系统就可以支持以网络为基础的 C-S 模型（虽然关注点更倾向于服务方），XQuartz 作为它的一种实现当然也不例外。但是出于[安全上的考虑](https://security.stackexchange.com/questions/14815/security-concerns-with-x11-forwarding)，XQuartz 默认是不允许通过网络进行交互的。要关闭这个限制，有两个方面要实现，分别对应 **具体操作** 中的1，2两个操作，第一个操作就像字面上的意思一样，关闭了网络连接限制，第二个操作则是关闭了连接鉴定（access control），可以通过运行 ```man xhost``` 来查看其 Man Page 以获得更多的信息。需要注意的是，因为本次实验的操作都是在本地实现的，所以完全关闭了连接鉴定，这在涉及到远程操作时是非常不安全的。

执行了上述步骤且 6000 端口被监听（默认情况）时，我们就成功在宿主机上运行起了 X Server，接下来就要解决第三个问题了。

## 0x32 如何让 Docker 中的 X Client  与宿主机的 X Server 实现交互

作为 X Client 的程序如果想与 X Server 进行交互，大致分为两种方式：

- 在命令后加 ```--display``` 参数并指明相关的位置
- 用户提前设置好环境变量 ```DISPLAY``` ，程序从该变量获得相关信息

这里我们采用第二种方式，故在启动容器时通过 ```-e``` 参数为其设置 ```DISPLAY``` 变量，现在的问题在于，如何解释变量的值 ```host.docker.internal:0``` 呢？

对于该变量中，冒号前面的部分，[Docker 官方文档](https://docs.docker.com/docker-for-windows/networking/ )中有如下解释：

> The host has a changing IP address (or none if you have no network access). From 18.03 onwards our recommendation is to connect to the special DNS name ```host.docker.internal```, which resolves to the internal IP address used by the host. 

也就是说，这个值本质上是获得了宿主机的内部IP，为了验证这一点，可以通过 ```ifconfig``` 命令来查看宿主机实际的IP，并将 ```DISPLAY``` 的值换成 ```your_ip:0``` ，可以发现和前面一样可以运行。之所以本次实验采用了前者，是因为要获取实际IP，第一是过程很麻烦，第二是设备要处于联网的状态下，而在文档的描述中可以看到 ```(or none if you have no network access)``` 这句话，也就是说，这种参数设置在无网络的条件下也可以正常运行。

那么 ```DISPLAY``` 的值就可以被解释为 ```your_ip:0``` 了，关于这个格式，其实它的完整形式为 ```your_ip: display_number. screen_number``` ，在本实验中其实可以写为 ```host.docker.internal:0.0```，```display_number``` 和 ```screen_number``` 均从0开始计数，前者表示一个输入流的标号（输入流包括显示器，键盘，鼠标等），后者表示输入流中某个具体的显示屏，因为很少有人使用多屏幕，所以 ```screen_number``` 多数情况下均为0，也就可以省略掉了。

而对于 ```display_number```，[X11 protocol 官方文档](https://www.x.org/releases/X11R7.7/doc/xproto/x11protocol.html)中有如下描述：

> For TCP connections, displays on a given host are numbered starting from 0, and the server for display N listens and accepts connections on port 6000 + N.

也就是说，这个值实际上取决于宿主机上 X11 服务占用的端口，用端口号减掉6000即可，这就是上述命令中冒号后面的0的具体含义。为了验证这一点，可以使用 ```socat``` 工具运行 ``` socat tcp-listen:6100,reuseaddr,fork tcp:localhost:6000``` 命令，将6100端口的消息转交给6000端口，这样按照上面的描述，```DISPLAY``` 变量的值就可以为 ```host.docker.internal:100``` ，替换后执行完整命令，可以发现一样能运行GUI测试程序。