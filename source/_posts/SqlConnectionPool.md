---
title: 从连接池的角度阅读 database/sql 包的源码
date: 2023-04-12 22:46:54
categories:
 - [Golang]
description: 读码使人快乐，读面向接口的码使人痛苦
---

# 前言

golang 标准库中的 database/sql 包提供了一种数据库的抽象，这种抽象面向接口，所以与具体的数据库无关。这意味着，开发人员几乎可以使用同一套代码来使用不同的数据库，只需要导入对应的数据库驱动即可，而这个所谓的驱动其实就是实现了 database/sql 中的接口的外部库。这里不对 database/sql 中接口的层级关系做介绍，感兴趣的朋友可以阅读 《go 语言设计与实现》的这篇文章（TBD）来学习。

正如 Driver.Open（TBD）和 Connector.Connect（TBD）方法的注释所言，数据库驱动不需要自己缓存打开的连接，因为 database/sql 除了通过接口对使用者屏蔽了底层驱动间的差异外，还维护了一份连接池。本文尝试从源码的角度分析连接池，期间顺带会聊到 database/sql 本身的一些特性，为方便描述，下文将 database/sql 简称为 sql。

# 连接池简述

“池化”通常用来复用曾经创建过的资源，是节省资源的一种很常见的方式，比如 goroutine 池和对象池，分别用于复用 goroutine 和某种对象。与之类似的，连接池是一种对连接的复用技术，广泛应用在 cs 架构中。对于一个连接池而言，常见的特性包括限制池大小、连接入池、连接出池、按需创建连接、清理过期连接、统计连接信息等，接下来分别分析下相关的特性。

# 源码解读

## 获取数据库句柄

sql.DB（TBD）是 sql 包对使用者暴露的数据库句柄，可以通过 sql.Open（TBD）函数获得。sql.Open 接收 driverName 和 dataSourceName 作为入参，前者用于在全局的 drivers map 中查找对应的驱动实现（这个 map 是通过调用 sql.Register（TBD）函数来写入的），后者则是一个现有标准，通常被简称为 dsn，这个东西定义了一系列连接数据库所需的参数，对应的驱动实现会通过 dsn 来完成连接的建立与初始化。

继续来看 sql.Open，当它从 drivers 中获取到驱动后，就会根据这个驱动来调用 sql.OpenDB（TBD）函数，这个函数接收 driver.Connector （TBD）作为入参，这是需要被数据库驱动实现的接口，通过调用其 Connect 方法 就可以获取到一条新的数据库连接。sql.OpenDB 做的事情很简单，它把这个 driver.Connector 塞到 sql.DB 结构中，然后初始化了一些关键字段，再另起一个 goroutine 调用 sql.DB 的 connectionOpener 方法后就结束了。

这里的 sql.DB.connectionOpener 是我们遇到的第一个后台运行的 goroutine，它的逻辑很简单，内部是一个 for-select 的无限循环，当且仅当入参的 ctx.Done 函数返回时，这个循环才会结束（因为这个 ctx 是与 DB.stop 绑定的，如果 ctx.Done 返回，那么意味着整个 DB 都失效了）。除此之外，connectionOpener 会尝试从 sql.DB.openerCh 字段中读取内容，这个字段是一个 channel，表示有一个创建连接的需求，每次读到时就调用 sql.DB.openNewConnection。我们先不看这个 openNewConnection，目前只需要了解它会创建新的连接即可。

## 创建或从池中获取连接

从上面的描述中我们会发现，从 Open 到 OpenDB 这整个获取 sql.DB 的过程中都不曾建立过真正的数据库连接，但 sql.DB 中确实在 connector 字段中保存了被数据库驱动实现的 driver.Connector 实例，也就是说 sql.DB 是有能力建立一条真正的数据库连接的。事实上，sql.DB 的连接是延迟建立的，也就是说只有真正需要用到连接时才会去创建第一条连接。那么什么时候会创建连接呢，通常是通过 sql.DB 来与数据库交互的时候，这里的交互指的是 DB.PingContext（TBD）、DB.QueryContext（TBD）、DB.ExecContext(TBD)。

通过查看代码，可以发现它们几乎有着同样的代码结构，都是先最多尝试 maxBadConnRetries 次以 cachedOrNewConn 这个策略调用一个非导出函数，如果均失败且失败原因是 driver.ErrBadConn，那么尝试以 alwaysNewConn 这个策略调用同样的函数。如果展开 DB.exec 和 db.query，那么这三个数据库交互函数的结构基本就完全一样了，cachedOrNewConn 和 alwaysNewConn 都是传给 DB.conn（TBD）函数的。

下面继续来看 DB.conn 这个函数，它的作用是获取一条数据库连接，而前面说的 cachedOrNewConn 和 alwaysNewConn 对它而言是获取连接的策略，前者意味着“从连接池中获取连接或创建一个新的连接”，后者意味着“直接创建一条新连接”。它们两个的区别在于是否会尝试从 DB.freeConn 中获取连接，这个字段保存曾经打开的但目前没在使用的连接，**也就是连接池的实体部分**。当策略为 cachedOrNewConn 且 DB.freeConn 中有内容时，就获取里面的第一个连接（这里弹出第一个连接的方式比较有考虑，感兴趣的朋友可以想想为什么不直接用 `db.freeConn[1:]` 的方式），然后通过提前设置的 DB.maxLifetime 判断它是否过期，当过期时会直接返回 driver.ErrBadConn，此时如前所述，调用者会重试 maxBadConnRetries 次。除此之外，DB.conn 还会按需调用驱动实现的 ResetSession 来重置连接。

如果 freeConn 中没有空闲的连接，或者 caller 已经重试了 maxBadConnRetries 次，那么就需要创建新的连接了。通常而言，只需要通过调用 DB.connector.Connect 方法，也就是数据库驱动实现的用于创建连接的方法即可。然而 sql 包支持设置连接的最大数量（**不是连接池的最大容量**），那么当多个 goroutine 都尝试创建新的数据库连接时，DB.conn 需要保证整体的连接数量是小于等于允许的最大连接数的。在实现上，DB.numOpen 记录了当前打开的连接数量，DB.maxOpen 记录了允许打开的最大连接数量，当 `DB.numOpen >= DB.maxOpen` 时，就需要阻塞当前的 goroutine 直到有空闲的连接可以使用。sql 通过 select 来实现阻塞，它先把当前 goroutine 对连接的“需求”封装成一个 connRequest 的 channel，然后再通过 select 尝试从这个 channel 中读取数据，如果能读到，那么它就能从中获取一条数据库连接并继续后面的逻辑。不难猜到，当且仅当其他 goroutine 释放了其占用着的连接，也就是将其放回连接池时，当前阻塞的 goroutine 才能接手这个连接，因为这样整体上连接的数量才不会变，下面我们就来看一下放回连接的部分。

## 将连接放回连接池

用户通过 DB 句柄与数据库交互前，需要通过 DB.conn 来新建或从连接池中获取，那么当这个交互完成时，就可以释放掉前面获得的连接了。还是回到 DB.PingContext、DB.QueryContext、DB.ExecContext，它们内部在调用 DB.xxxDC 时接受了 driverConn 的 releaseConn 方法，当 DB.xxxDC 结束时，releaseConn 就会被调用，而这个方法的逻辑很简单，仅仅只是调用了 DB.putConn 方法。

从名字上看，DB.putConn 的作用是将连接放回连接池。具体到代码中，如果这个连接不是 driver.ErrBadConn，也就是说连接当前还可用，那么 DB.putConn 就会尝试调用 DB.putConnDBLocked，这个方法真正用于将连接放回连接池，并返回是否放回成功，当不成功时代表连接池已经满了，此时 DB.putConn 会直接调用 driverConn.Close （TBD）来关闭这个连接。

继续来看 DB.putConnDBLocked（TBD），它首先会判断当前是否有 goroutine 因为获取不到连接而阻塞，如果存在这样的 goroutine，那么把当前连接通过对应 goroutine 的 connRequest channel 转让给它，此时 putConnDBLocked 会返回 true 避免 caller 认为连接放回连接池失败并关闭 driverConn。而如果没有阻塞中的 goroutine，那么 putConnDBLocked 会判断 DB.freeConn 中的连接是否达到 DB.maxIdleConn，即允许空闲的最大连接数量，如果没有达到，那么将该连接加入到 DB.freeConn 中并返回 true，否则返回 false 通知 caller 关闭连接。

需要注意的是，DB.maxIdleConn 与 DB.maxOpen 不同，前者代表“最多有多少空闲连接”，后者代表“最多有多少连接”，所以前者是一定小于等于后者的，从语义上讲，前者就是**连接池的最大容量**。

这里讲的是正常的流程，但 DB.putConn 接收到的连接很可能是有问题的，这里的问题就是 driver.ErrBadConn，这通常发生于数据库服务端主动断开连接。当连接的状态是有问题的时候，DB.putConn 就会直接关闭这个连接。但与此同时，它还会调用 DB.maybeOpenNewConnections（TBD），这是为了对新建连接这个操作进行兜底，被多个 `err != nil` 的地方调用。

## 新连接兜底

TBD

## 过期连接清理

TBD

## Tx 和 Stmt 如何使用连接

TBD

## 统计连接池信息

TBD
