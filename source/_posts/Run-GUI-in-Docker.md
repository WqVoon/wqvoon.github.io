---
title: 在 Docker for MacOS 中运行 GUI 程序
date: 2019-10-14 23:04:14
categories: Docker
---

内容包括：前言+环境+具体操作+原理



<!-- more -->



# 0x00 前言

在初步接触了 Docker 后，突然萌生了一个“可不可以在其中跑GUI程序的念头”，遂急忙STFW&&RTFM，并在查阅了相关的一些文档后，成功在本地运行了容器内的GUI测试程序，下面记录一下相关的工作和原理。

# 0x01 相关环境

```bash
Docker version 18.09.2
XQuartz 2.7.11（xorg-server 1.18.4)
```

以上软件均可通过 **homebrew** 进行安装

# 0x02 具体操作

1. XQuartz -> 偏好设置 -> 安全性 -> 勾选“允许从网络客户端连接” -> 退出程序；
2. 终端键入 ```xhost +```（注意两者之间的空格）重新启动 XQuartz；
3. 使用诸如 nmap 类的工具查看 6000 端口是否被 X11 服务占用，如果已经被占用即可继续下一步操作，如果没有被占用的话...因为没遇到过所以我也不知道怎么办:-P；
4. 在 run 或 exec 容器时加入```-e DISPLAY=host.docker.internal:0```参数，比如我这里通过对一个现有的，已经安装过 xarclock 时钟小程序的容器 toyOS 执行```docker exec -ite DISPLAY=host.docker.internal:0 toyOS /usr/bin/xarclock```，就会在我的本地出现一个小时钟的GUI程序；

# 0x03 相关原理

