---
title: 设计模式之单例模式
date: 2020-11-13 19:44:23
categories: 设计模式
---

# 0x0 前言

单例模式是一个比较简单的模式，其目的在于**确保某一个类只有一个实例，并且自行实例化并向整个系统提供这个实例**。一般来说，对于一些创建、销毁比较昂贵的对象实例，也许使用单例模式是一个不错的选择。比如一个始终需要从键盘获取用户输入的系统，我们可以在类似 Utils 的静态类中设置一个全局唯一的Scanner类，始终用于获取用户的输入，从而避免每次创建删除同类对象产生的开销。

# 0x1 基本代码

很多设计模式相关的教程上都将单例模式分为饿汉单例和懒汉单例，它们的基本代码如下：

```java
// 饿汉单例
class Singleton {
  static private Singleton instance = new Singleton();

  private Singleton() {}

  public static Singleton getInstance() {
    return instance;
  }
}

// 懒汉单例（线程不安全）
class Singleton {
  static private Singleton instance = null;

  private Singleton() {} 

  public static Singleton getInstance() {
    if (instance == null) {
      instance = new Singleton();
    }
    return instance;
  }
}
```

可以看到，为了限制客户端对该对象的多次实例化，两者的 constructor 均被设置为 private 可见性，并对外暴露静态方法 getInstance 用于返回内部的实例。区别在于，懒汉单例应用了 lazy loading 的思想，使得 instance 的实例化延迟到 getInstance 方法真正被调用时；而饿汉单例借助了 ClassLoader 的能力，让 instance 的实例化在 Singleton 类被加载时便进行了。

# 0x2 懒汉单例与线程安全

就像上面的注释所言，上述形式的懒汉模式并不是线程安全的，原因在于 `instance == null` 这句判断在并发的场景下是非常靠不住的，比如如下的代码：

```java
public class App {
  public static void main(String[] args) {
    for (int i=0; i<5; i++) {
      new Thread(() -> {
        Singleton.getInstance();
      }).start();
    }
  }
}

class Singleton {
  static private Singleton instance = null;

  private Singleton() {
    System.out.println("An instance has been created");
  } 

  public static Singleton getInstance() {
    if (instance == null) {
      instance = new Singleton();
    }
    return instance;
  }
}
```

在笔者的设备上共输出了5次 `An instance has been created` ，也就是产生了5个不同的对象，这并不符合单例模式。

针对上述问题，可以通过 synchronized 关键字对代码进行加锁，从而在保证线程安全的条件下实现懒汉单例。