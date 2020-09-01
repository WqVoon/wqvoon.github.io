---
title: 记一次手贱的经历与解决办法
date: 2020-09-01 10:01:35
categories: Docker
description: 如果手贱在 Docker desktop for mac 的容器中运行了 chattr +a 后又在宿主机上运行了 docker rm 的话该怎么办呢...
---

# 0x0 起因

一直以来对 Linux 的权限管理都仅仅停留在 “知道有这种机制存在” 的程度上，最近为某比赛出题时因为要有 getshell 的环境，所以就趁机了解了一下其中的一些理论和对应的命令。

由于我本人平时使用的是 MacOS 系统，再加上赛题环境也要扔到 docker 中，所以在学习权限管理时在 docker 里开了一个容器作为环境，测试的命令包括 chown，chroot，lsattr，chattr... 等等（这里插一句题外话，为了在容器中运行 chattr ，需要在启动时加上 ` --cap-add LINUX_IMMUTABLE` 参数来为其赋予一个 capability ），在了解到可以开始创建赛题环境的程度后，我退出了容器，并运行了 `docker rm ...` 来将测试用的容器删除掉。

正当我准备开始输入命令创建新的容器时，却看到 docker 并没有正常删除测试用容器，取而代之地返回了一条蜜汁信息（这里省略了容器对应的两个哈希，该哈希对应我上文提到的那个用于测试权限管理的容器）：

```shell
Error response from daemon: container ...: driver "overlay2" failed to remove root filesystem: unlinkat /var/lib/docker/overlay2/.../diff/test/file: operation not permitted
```

可以看到，大意是 docker 没有权限删除容器中的 /test/file 文件，比较幸运地，我记得这个文件是经历了 `chattr +a file` 处理后的文件，这个隐藏属性使得文件只可被追加新的内容而不可被删除或者修改。

起初我觉得这个问题很好解决（实际也很好解决，只不过和我开始想的不同），如果是在 docker for linux 上，直接在宿主机切到对应的目录后运行 `chattr -a file` 去掉隐藏属性，然后继续运行 `docker rm ...` 删掉容器即可；docker for macos 无非就是多了一层 HyperKit，可以用 screen 进入到 vm 中（我本机上是 `screen ~/Library/Containers/com.docker.docker/Data/vms/0/tty`），然后进行和上文相同的操作。

然而进去才发现，这个 vm 提供的命令太少了，根本没有 chattr 命令可用，尝试搜索是否有等效的命令可用也没有搜到，更没有人手贱到和我一样，所以现在的场景也没有先人的经验可以学习。虽然这一个容器本身并没有占多大的空间，但是强迫症使然，我还是想把它删除掉:-P

# 0x1 解决办法

## 0x10 Hard Reset

最初我尝试自己在 StackOverflow 上提出了这一问题，然而也不知道是因为环境描述的不到位还是因为自己小学水平的英文写作能力，下面的答复甚至都没有对应到这个问题上...

只有一位老哥给了还算靠谱的答复，他建议我强制重置 docker desktop for mac 的状态（Troubleshoot/Reset disk image 或者 Troubleshoot/Reset to factory defaults），这俩都会清空当前的所有的镜像和容器，后者还会顺手把应用重置成刚被安装后的状态。

确实是一个解决办法，不过因为我平时都是把 docker 当虚拟机用的，所以本机上存着各种镜像，其中还包括好多自定制的，一个一个导出来实在是太过麻烦，而我又不怎么了解这些镜像是怎么个存储机制，胡乱备份的话还担心弄出别的问题，所以就放弃了这个办法。

## 0x11 Chroot

在 vm 里畅游了一阵子后，我偶然发现这货还是有 chroot 可以用的，于是随便切到一个包含根目录的容器层里（我本机的路径是 `/var/lib/docker/overlay2/.../diff` ，这里依然省略了哈希），试着执行了一下 `chroot . /bin/bash` ，虽然给了一条 `groups: cannot find name for group ID 11` 的奇怪信息，不过还是顺利地进入到了 bash 环境中，而且测试了一下后发现 chattr 命令可用。

这样的话就好办多了，**在无法删除的文件所在的文件夹或父文件夹中构建出 chattr 的运行环境，然后利用 chroot 运行 `chattr -a file` 来删除文件的隐藏属性，再在宿主机中运行 `docker rm ...` 即可**

在其他容器中（下文用 other 来指代）用 ldd 查看下 chattr 依赖的动态链接库，得到结果如下：

```shell
root@docker-desktop:/# ldd $(which chattr)
        linux-vdso.so.1 (0x00007ffebb9fc000)
        libe2p.so.2 => /lib/x86_64-linux-gnu/libe2p.so.2 (0x00007f6ce8b0a000)
        libcom_err.so.2 => /lib/x86_64-linux-gnu/libcom_err.so.2 (0x00007f6ce8906000)
        libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f6ce8515000)
        libpthread.so.0 => /lib/x86_64-linux-gnu/libpthread.so.0 (0x00007f6ce82f6000)
        /lib64/ld-linux-x86-64.so.2 (0x00007f6ce8f17000)
```

可以看到依赖库都在 /lib/x86_64-linux-gnu/ 和 /lib64/ 文件夹中，所以在目标文件夹（这里指无法删除的文件 file 所在的文件夹）中用 `cp -R` 把 other 中这两个文件夹中的内容拷贝过来，再把 chattr 的 ELF 文件拷到目标文件夹中，最后在目标文件夹中运行 `chroot . ./chattr -a file` 即可。

删除了隐藏属性后，切回到宿主机中，然后运行 `docker rm ...` 就可以顺利删除掉这个出了问题的容器了。