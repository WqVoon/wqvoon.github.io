---
title: 从连接池的角度阅读 database/sql 包的源码
date: 2023-04-12 22:46:54
categories:
 - [Golang]
description: 读码使人快乐，读面向接口的码使人痛苦
---

# 前言

golang 标准库中的 database/sql 包提供了一种数据库的抽象，这种抽象面向接口，所以与具体的数据库无关。这意味着，开发人员几乎可以使用同一套代码来使用不同的数据库，只需要导入对应的数据库驱动即可，而这个所谓的驱动其实就是实现了 database/sql 中的接口的外部库。这里不对 database/sql 中接口的层级关系做介绍，感兴趣的朋友可以阅读 《go 语言设计与实现》的[这篇文章](https://draveness.me/golang/docs/part4-advanced/ch09-stdlib/golang-database-sql/)来学习。

正如 [Driver.Open](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/driver/driver.go#L88-L90) 和 [Connector.Connect](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/driver/driver.go#L123-L125) 方法的注释所言，数据库驱动不需要自己缓存打开的连接，因为 database/sql 除了通过接口对使用者屏蔽了底层驱动间的差异外，还维护了一份连接池。本文尝试从源码的角度分析连接池，期间顺带会聊到 database/sql 本身的一些特性，为方便描述，下文将 database/sql 简称为 sql。

# 连接池简述

“池化”通常用来复用曾经创建过的资源，是节省资源的一种很常见的方式，比如 goroutine 池和对象池，分别用于复用 goroutine 和某种对象。与之类似的，连接池是一种对连接的复用技术，广泛应用在 cs 架构中。对于一个连接池而言，常见的特性包括限制池大小、连接入池、连接出池、按需创建连接、清理过期连接、统计连接信息等，接下来分别分析下相关的特性。

# 源码解读

## 获取数据库句柄

[sql.DB](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L456) 是 sql 包对使用者暴露的数据库句柄，可以通过 [sql.Open](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L816-L833) 函数获得。sql.Open 接收 driverName 和 dataSourceName 作为入参，前者用于在全局的 [drivers](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L35) map 中查找对应的驱动实现（这个 map 是通过调用 [sql.Register](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L44-L54) 函数来写入的），后者则是一个现有标准，通常被简称为 dsn，这个东西定义了一系列连接数据库所需的参数，对应的驱动实现会通过 dsn 来完成连接的建立与初始化。

继续来看 sql.Open，当它从 drivers 中获取到驱动后，就会根据这个驱动来调用 [sql.OpenDB](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L784-L797) 函数，这个函数接收 [driver.Connector](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/driver/driver.go#L121-L141) 作为入参，这是需要被数据库驱动实现的接口，通过调用其 Connect 方法就可以获取到一条新的数据库连接。sql.OpenDB 做的事情很简单，它把这个 driver.Connector 塞到 sql.DB 结构中，然后初始化了一些关键字段，再另起一个 goroutine 调用 sql.DB 的 connectionOpener 方法后就结束了。

这里的 [sql.DB.connectionOpener](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1193-L1203) 是我们遇到的第一个后台运行的 goroutine，它的逻辑很简单，内部是一个 for-select 的无限循环，当且仅当入参的 ctx.Done 函数返回时，这个循环才会结束（因为这个 ctx 是与 DB.stop 绑定的，如果 ctx.Done 返回，那么意味着整个 DB 都失效了）。除此之外，connectionOpener 会尝试从 sql.DB.openerCh 字段中读取内容，这个字段是一个 channel，表示有一个创建连接的需求，每次读到时就调用 sql.DB.openNewConnection。我们先不看这个 openNewConnection，目前只需要了解它会创建新的连接即可，详细的内容会在后面介绍。

## 创建或从池中获取连接

从上面的描述中我们会发现，从 Open 到 OpenDB 这整个获取 sql.DB 的过程中都不曾建立过真正的数据库连接，但 sql.DB 中确实在 connector 字段中[保存](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L787)了被数据库驱动实现的 driver.Connector 实例，也就是说 sql.DB 是有能力建立一条真正的数据库连接的。事实上，sql.DB 的连接是延迟建立的，也就是说只有真正需要用到连接时才会去创建第一条连接。那么什么时候会创建连接呢，通常是通过 sql.DB 来与数据库交互的时候，这里的交互指的是 [DB.PingContext](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L848-L866)、[DB.QueryContext](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1670-L1683)、[DB.ExecContext](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1597-L1610)。

通过查看代码，可以发现它们几乎有着同样的代码结构，都是先最多尝试 [maxBadConnRetries](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1508-L1511) 次以 cachedOrNewConn 这个策略调用一个非导出函数，如果均失败且失败原因是 driver.ErrBadConn，那么尝试以 alwaysNewConn 这个策略调用同样的函数。如果展开 DB.exec 和 DB.query，那么这三个数据库交互函数的结构基本就完全一样了，cachedOrNewConn 和 alwaysNewConn 都是传给 [DB.conn](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1259) 函数的。

下面继续来看 DB.conn 这个函数，它的作用是获取一条数据库连接，而前面说的 cachedOrNewConn 和 alwaysNewConn 对它而言是获取连接的策略，前者意味着“从连接池中获取连接或创建一个新的连接”，后者意味着“直接创建一条新连接”。它们两个的区别在于是否会尝试从 DB.freeConn 中获取连接，这个字段保存曾经打开的但目前没在使用的连接，**也就是连接池的实体部分**。当策略为 cachedOrNewConn 且 DB.freeConn 中有内容时，就获取里面的第一个连接（这里弹出第一个连接的方式比较有考虑，感兴趣的朋友可以想想为什么不直接用 `db.freeConn[1:]` 的方式），然后通过提前设置的 DB.maxLifetime 判断它是否过期，当过期时会直接返回 driver.ErrBadConn，此时如前所述，调用者会重试 maxBadConnRetries 次。除此之外，DB.conn 还会按需调用驱动实现的 ResetSession 来重置连接。

如果 freeConn 中没有空闲的连接，或者 caller 已经重试了 maxBadConnRetries 次，那么就需要创建新的连接了。通常而言，只需要通过调用 DB.connector.Connect 方法，也就是数据库驱动实现的用于创建连接的方法即可。然而 sql 包支持设置连接的最大数量（**不是连接池的最大容量**），那么当多个 goroutine 都尝试创建新的数据库连接时，DB.conn 需要保证整体的连接数量是小于等于允许的最大连接数的。在实现上，DB.numOpen 记录了当前打开的连接数量，DB.maxOpen 记录了允许打开的最大连接数量，当 `DB.numOpen > DB.maxOpen` 时，就需要阻塞当前的 goroutine 直到有空闲的连接可以使用。sql 通过 select 来实现阻塞，它先把当前 goroutine 对连接的“需求”封装成一个 connRequest 的 channel，然后再通过 select 尝试从这个 channel 中读取数据，如果能读到，那么它就能从中获取一条数据库连接并继续后面的逻辑。不难猜到，当且仅当其他 goroutine 释放了其占用着的连接，也就是将其放回连接池时，当前阻塞的 goroutine 才能接手这个连接，因为这样整体上连接的数量才不会变，下面我们就来看一下放回连接的部分。

## 将连接放回连接池

用户通过 DB 句柄与数据库交互前，需要先通过 DB.conn 来新建或从连接池中获取连接，那么当这个交互完成时，就可以释放掉前面获得的连接了。还是回到 DB.PingContext、DB.QueryContext、DB.ExecContext，它们内部在调用 DB.xxxDC 时接受了 driverConn 的 releaseConn 方法作为参数，当 DB.xxxDC 结束时，releaseConn 就会被调用，而这个方法的逻辑很简单，仅仅只是调用了 [DB.putConn](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1414) 方法。

从名字上看，DB.putConn 的作用是将连接放回连接池。具体到代码中，如果这个连接不是 driver.ErrBadConn，也就是说连接当前还可用，那么 DB.putConn 就会尝试调用 DB.putConnDBLocked，这个方法真正用于将连接放回连接池，并返回是否放回成功，当不成功时代表连接池已经满了，此时 DB.putConn 会直接调用 [driverConn.Close](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1461) 来关闭这个连接。

继续来看 [DB.putConnDBLocked](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1475)，它首先会判断当前是否有 goroutine 因为获取不到连接而阻塞，如果存在这样的 goroutine，那么把当前连接通过对应 goroutine 的 connRequest channel 转让给它，此时 putConnDBLocked 会返回 true 避免 caller 认为连接放回连接池失败并关闭 driverConn。而如果没有阻塞中的 goroutine，那么 putConnDBLocked 会判断 DB.freeConn 中的连接是否达到 DB.maxIdleConn，即允许空闲的最大连接数量，如果没有达到，那么将该连接加入到 DB.freeConn 中并返回 true，否则返回 false 通知 caller 关闭连接。

需要注意的是，DB.maxIdleConn 与 DB.maxOpen 不同，前者代表“最多有多少空闲连接”，后者代表“最多有多少连接”，所以前者是一定小于等于后者的，从语义上讲，前者就是**连接池的最大容量**。

这里讲的是正常的流程，但 DB.putConn 接收到的连接很可能是有问题的，这里的问题就是 driver.ErrBadConn，这通常发生于数据库服务端主动断开连接。当连接的状态是有问题的时候，DB.putConn 就会直接关闭这个连接。但与此同时，它还会调用 [DB.maybeOpenNewConnections](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1175)，这是为了对新建连接这个操作进行兜底，被多个 `err != nil` 的地方调用。

## 新连接兜底

从名字上看，DB.maybeOpenNewConnections “可能”会创建一个新的连接。它通常被用于新连接的兜底，偶尔就会被调用一下，服务于那些由于拿不到连接而阻塞的 goroutine。

具体到代码中，它会判断当前有多少个 goroutine 因为获取不到连接而阻塞，如前所述，每一个这种 goroutine 都对应一个 connRequest，所有的 connRequest 被放在 [DB.connRequests](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L469) 字段中。但我们不能 DB.connRequests 中有多少个元素就创建多少个连接，而是要结合 DB.maxOpen 的值来判断，如前所述，这个值的含义是“最多允许建立多少条数据库连接”。当 DB.maxOpen 大于 0 时，DB.maybeOpenNewConnections 会计算 `DB.maxOpen - DB.numOpen` 的值，这个值的含义是“还能创建多少条数据库连接”。

所以 `min(len(DB.connRequests), (DB.maxOpen-DB.numOpen))` 的值，就是当前可以创建的连接数量，我们假设它为 n，那么 DB.maybeOpenNewConnections 就会向 DB.openerCh 中写入 n 次。如果你还有印象的话，我们前面提到，sql.OpenDB 函数创建了一个 goroutine，这个 goroutine 做的就是不断尝试从 DB.openerCh 中读取内容，当有内容时就调用 [DB.openNewConnection](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1206) 来创建新的连接。

下面来看下 DB.openNewConnection 的逻辑，它首先就调用驱动实现的 Connector.Connect 创建了一个连接，如果连接创建失败，它会调用 DB.putConnDBLocked，但这里对这个函数的使用不同于我们前面的描述，它会将驱动返回的错误传递进去，这个错误会一路通过 connRequest 传给对应的 gouroutine 从而使其结束阻塞，并在 err 为 sql.ErrBadConn 时进行重试。除此之外，它会再次调用 DB.maybeOpenNewConnections，这样新的一轮 DB.openNewConnection 调用就会按需被发起。

另一方面，如果 DB.openNewConnection 成功通过数据库驱动创建了一条连接，那么它同样会调用 DB.putConnDBLocked，只不过会将连接传递进去，此时 DB.putConnDBLocked 的作用就和我们前面提到的是相同的，当这个函数返回 false 时，说明已经不能再创建新的连接了，此时调用 Close 来关闭刚刚创建的连接。

## 过期连接清理

由于网络环境的不稳定，我们无法保证池子中的连接是可用的，虽然在使用时 sql 会适度重试，但这种重试是很影响效率的。为了解决这个问题，通常有两种方案。第一是定期通过池子中的连接 ping 一下，如果成功那么保留，否则丢弃掉连接；第二种是为每个连接设置最大可用时长，超过这个时长的连接会被丢弃。两种方式各有利弊，sql 选择了第二种。

当我们通过 [DB.SetConnMaxLifetime](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1011) 设置 DB.maxLifetime 或通过 [DB.SetConnMaxIdleTime](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1033) 设置 db.maxIdleTime 时，它们均会调用 [DB.startCleanerLocked](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1052)，这个函数的作用是按需初始化 DB.cleanerCh，然后新起一个协程调用 [DB.connectionCleaner](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1059)，这是我们遇到的第二个后台运行的 goroutine。

与 DB.connectionOpener 类似，DB.connectionCleaner 也是一个通过 for+select 来运行的协程，但不同的是它的退出条件[更容易满足](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1076)。select 中有两个 case，一个用于每隔一段时间执行一次，这通过在循环中对 Timer 调用 Reset 实现，另一个则从 DB.cleanerCh 中读取内容。不管命中了哪个 case，DB.connectionOpener 的作用都是寻找那些已经过期的连接，然后分别对它们调用 Close 来进行关闭。

当前 DB.cleanerCh 的写入方有两处，分别是前面提到的 DB.SetConnMaxLifetime 和 DB.SetConnMaxIdleTime，当设置的新值比旧值小的时候会通知 DB.connectionOpener 强制执行一次清理。

## Tx 和 Stmt 如何使用连接

上面描述的过程概括了常规的数据库交互方式，简单来说就是交互前尝试获取一个连接，这个连接可能是新建的也可能是从连接池中拿到的，交互结束再把连接放回池子里，如果池子满了就把连接关掉。但 sql 中有一些交互不适用于这个过程，比较典型的是 [sql.Tx](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2101) 和 [sql.Stmt](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2537)。

sql.Tx 代表事务，它是一个句柄，可以通过 [DB.BeginTx](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1805) 来获得，用户拿到这个句柄后，可以通过 sql.Tx 调用与 sql.DB 类似的方法，然后调用 Tx.Commit 或 Tx.Rollback 来完成事务的处理。对应到数据库上，就是要先送一条语句过去开启事务（比如 BEGIN），然后执行一些操作，再按需执行 COMMIT 或 ROLLBACK。这里最大的问题在于，事务是不能跨连接的，也就是说，在提交或回滚之前，Tx 的所有操作都应该是通过同一条连接来完成的，这意味着 Tx 需要独占某一条连接。

在实现上，DB.BeginTx 展开后和前面提到的其他交互函数相同，也是调用了 db.conn 来获取连接，但 [db.beginDC](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1838) 和前面的几个 db.xxxDC 不同，它没有通过 defer 来调用 driverConn.releaseConn，这也就意味着当 DB.beginDC 将 BEGIN 命令发送给数据库后，之前获取的连接并不会放回连接池。与之相对的，db.beginDC 将 releaseConn 记录在 Tx.releaseConn 字段内，当 [Tx.Commit](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2223) 或 [Tx.Rollback](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2262) 被调用时，这个函数就会被调用到，此时 Tx 独占的连接就可以被释放了。

从这里我们就能看到，在写业务代码时应该尽量避免长事务，因为每个事务都会独占一条数据库连接，如果限制了 DB.maxOpen 的值，那么很快就达到限制了，此时那些想要获取连接的 goroutine 都会因为迟迟拿不到连接而阻塞在 connRequest。

接下来再来看 sql.Stmt，这个东西对应数据库中的 prepare 语句，它同样是一个句柄，可以通过 [DB.PrepareContext](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1521) 来获得。同 Tx 一样，Stmt 是不能跨 session 的，所以理所当然的，我们可以把 Stmt 实现成 Tx 的方式，即每个 Stmt 独占一条连接。然而，和 Tx 不同的是，Stmt 是一个长期存在的东西（即它本身不存在 commit 和 rollback），而且由于它能够提高 sql 的执行效率，所以对于一个高效的系统，Stmt 应该是会被经常使用的东西。这两点特性决定了我们无法用实现 Tx 的方式来实现 Stmt，否则这个长期存在的东西会一直占据连接的份额，就相当于系统中有了一个几乎不会结束的事务。

因此，[DB.prepareDC](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1565) 中使用 defer 调用了 driverConn.releaseConn 来释放对应的连接，这意味着当 DB.prepareDC 被调用后，所有连接中有一条连接是被 prepare 过的。但是，正是由于连接池的存在，所以这条连接不一定会被哪个 goroutine 使用，那么当用户使用 Stmt 与数据库交互时，如何确保获取到一条 prepare 过的连接呢？

事实上，[Stmt.css](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2568) 中记录了一个 connStmt 列表，每个 connStmt 中记录了一个 prepare 过的 driverConn 和对应的 driverStmt。当用户使用 Stmt 与数据库交互时，首先会调用 [Stmt.connStmt](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2658) 方法，这个方法会尝试获取一条连接，然后遍历 Stmt.css，如果 Stmt.css 中某一项的 driverConn 与 DB.conn 获取到的 driverConn 相等，那么这一项的 driverStmt 就可以直接拿来使用，因为这意味着对应的连接已经被 prepare 过。

但我们不能总是这样幸运，当 Stmt.css 中没有与之匹配的 driverConn 时，就说明我们拿到了一条未经 prepare 的连接，此时需要通过 [Stmt.prepareOnConnLocked](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L2711) 来对这个连接执行 prepare 并获取对应的 driverStmt，然后通过这个 driverStmt 来执行操作。除此之外，Stmt.prepareOnConnLocked 还会将这对新的 driverConn 和 driverStmt 放入到 Stmt.css 中，避免下次在使用 Stmt 时重复对同一条连接执行 prepare。

## 统计连接池信息

最后也是最简单的一个连接池特性，就是获取统计数据，这可以通过 [DB.Stats](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1150) 方法获取。我们前面讨论的各个操作中会在 DB 结构中记录一些内容，比如”有多少连接因为过期而被关闭“，“有多少 goroutine 因为获取不到连接而阻塞”等等，但直到我们调用 DB.Stats 时，这些数据仍在变化着，所以我们需要对调用时的状态做一个快照，具体到代码中，sql 定义了 [DBStats](https://github.com/golang/go/blob/release-branch.go1.17/src/database/sql/sql.go#L1133) 结构，用于保存 DB.Stats 方法被调用时 DB 中各个统计字段的状态，因为这个结构体中没有指针字段，所以后续 DB 中统计字段的变化不会对这个结构有任何影响，这样就实现了统计数据的快照。
