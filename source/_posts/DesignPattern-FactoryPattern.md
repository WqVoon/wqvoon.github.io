---
title: 设计模式之工厂模式
date: 2020-11-05 20:41:00
categories: 设计模式
description: 简单工厂模式、工厂方法模式、抽象工厂模式
---

# 0x0 简单（静态）工厂模式

一般来说，OOP语言中获取对象的实例都是通过 new 关键字来调用对象的 constructor，从而将实例传递给某个引用或是具体的左值。constructor 根据特征标的不同来进行重载，以达到按需构建对象的目的。

但是这里有个问题，对象的初始化工作均交给了 constructor 来完成，这使得其代码往往变得很长，同时，把一些面向某个类而不是某个实例的操作（比如对实例在其类的内部用静态字段进行计数）写在 consturctor 中也不是很优雅。

更进一步的，像 Java 的 IO 操作中采用了 Filter 模式，这使得一个具备缓冲功能的 FileReader 看起来像这样：

```java
Reader bufferedReader = new BufferedReader(new FileReader(new File(...)))
```

如果每次产生这类对象时都这样写，虽然在业务上没什么问题，但是并不利于维护。比如假设突然有了把所有的 Reader 都变成 LineNumberReader 的需求的话，就要修改所有实例的 new 部分。

简单工厂模式就可以很好地解决上述这些问题。

要实现简单工厂模式，最基本的是需要一个工厂类，对于上述的 Reader，可以得到如下工厂：

```java
class ReaderFactory {
  // constructor 设置为 private，因为这个工厂内部只需要静态方法即可
  private ReaderFactory() {}

  public static Reader createReaderForFile(String filename)
  throws FileNotFoundException {
    return new BufferedReader(new FileReader(new File(filename)));
  }
}
```

这样在要获得 Reader 时，可以写类似 `Reader bufferedReader = ReaderFactory.createReaderForFile(...)` 的代码，而在日后遇到需要修改为 LineNumberReader 的维护需求时，只需要修改工厂中的代码即可。

这里可以发现，由于 Reader 们都实现了Reader 这个抽象类，所以利用多态的特性，返回的实例可以是任意的子类，那么实际上可以将工厂的生产方法修改为可以根据需求返回不同子类的形式，代码如下：

```java
class ReaderFactory {
  private ReaderFactory() {
  }

  public static Reader createReaderForFile(String filename, String readerType)
  throws FileNotFoundException {
    Reader fileReader = new FileReader(new File(filename));
    switch (readerType) {
    case "BufferedReader":
      return new BufferedReader(fileReader);
    case "LineNumberReader":
      return new LineNumberReader(fileReader);
    ...
    default:
      return fileReader;
    }
  }
}
```

这样，在客户端调用工厂的生产方法时，通过提供第二个参数即可获得不同功能的 Reader 对象。

虽然多数设计模式的书籍或文章在阐述某个模式时都会使用 Java 作为实现语言，但设计模式本身是作用于 OOP 的理念上，所以其他语言中也都有设计模式的身影。对于简单工厂模式，Vue 在使用 rollup 打包后产生的代码（通过结合立即执行表达式IIFE和闭包），我个人认为就是它的一个实现。

所以，简单工厂模式封装了一部分类的初始化行为，并可以提供按需构建不同子类的功能。这种模式方便了客户端代码（即使用工厂的代码），使其并不需要考虑工厂的具体实现，而只是按需为工厂传递参数即可。

# 0x1 工厂方法模式

虽然简单工厂模式方便了客户端代码，但是由于每次对功能的扩展都要修改工厂的内部代码，不但违反了“开放-封闭原则”，同时在工厂生产方法很大时，每次都要编译许多无关的代码，增大了开发的成本。

工厂方法模式就可以很好地解决上述问题。

为了举例，假设我们有一个 Pet 的接口，代码如下：

```java
interface Pet {
  void say();
}
```

现在分别定义猫和狗实体类来实现该接口：

```java
class Cat implements Pet {
  @Override
  public void say() {
    System.out.println("喵");
  }
}

class Dog implements Pet {
  @Override
  public void say() {
    System.out.println("汪");
  }
}
```

为了按需获取 Pet 的实例，我们可以定义 PetFactory 工厂：

```java
class PetFactory {
  private PetFactory() {}

  private static Pet DEFAULT_PET = new Pet() {
    @Override
    public void say() {
      System.out.println("Idk who am I");
    }
  };

  public static Pet createPet(String petType) {
    switch (petType) {
    case "Cat":
      return new Cat();
    case "Dog":
      return new Dog();
    default:
      return DEFAULT_PET;
    }
  }
}
```

这就是简单工厂模式的一个实现，那么按照上面所说的问题，假设现在要新添加一个 Pet 实体，除了添加一个实现了 Pet 接口的类以外，另要修改 PetFactory.createPet 方法中的 switch。

那么同样的需求，如果用工厂方法模式来实现会是什么样呢？

首先，需要把 PetFactory 从类转为接口：

```java
interface PetFactory {
  Pet createPet();
}
```

然后针对 Cat 和 Dog 分别实现其工厂：

```java
// 这里因为逻辑很简单，所以工厂的生产方法只是简单返回实体
class CatFactory implements PetFactory {
  @Override
  public Pet createPet() {
    return new Cat();
  }
}

class DogFactory implements PetFactory {
  @Override
  public Pet createPet() {
    return new Dog();
  }
}
```

这样，客户端的代码可以这样写

```java
public static void main(String[] args) {
  PetFactory catFactory = new CatFactory();
  PetFactory dogFactory = new DogFactory();
  catFactory.createPet().say();
  dogFactory.createPet().say();
}
```

在定义工厂的引用时，类型可直接定义为 PetFactory 接口，然后利用多态的特性来分发具体的工厂。这样一来，我们**定义了一个用于创建对象的接口，让子类来决定实例化哪一个类。工厂方法使一个类的实例化延迟到其子类**。

和简单工厂模式不同的是，工厂方法模式的客户端做了更多的工作，它需要知道某个实体类对应的具体工厂类。同时，在对实体类的种类进行扩展时，要同时定义这个新的实体类和其对应的工厂类。这样的缺点在于代码量比较大，修改的工作相对于简单工厂模式而言稍有复杂，而优点则在于解决了之前说的问题。即，遵循了“封闭-开放原则”，同时，通过添加新的类而不是修改原有的类来进行业务的扩展，使得按需编译成为可能，减少了开发的成本。

# 0x2 抽象工厂模式

抽象工厂模式的定义是**为创建一组相关或相互依赖的对象提供一个接口，并且无须指定它们的具体类**，从字面意义上来理解，就可以理解为工厂方法模式的加强。也就是说，此时工厂的目标在于创建一系列相互影响或关联的实体类，我们把这些类叫做**产品**，而由于工厂的具体实现不同，所以同类产品也有着一定的差异，在这个横向的对比上，我们把它们叫做一个**产品族**。

一般来说，抽象工厂模式适用于比较大的项目。比如可以定义一套跨平台的业务接口，让工厂来生产BO们，共同配合以实现某个功能。那么针对不同的平台，就可以有不同的工厂来屏蔽平台之间的差异。而站在客户端的角度，我们只需要结合多态来实例化目标平台的工厂类，就可以通过通用的接口来完成所需的功能。在这个过程中，尽管工厂生成的产品们联系密切，但客户端依然不需要了解产品族中各产品之间的具体差异。

这即是说，抽象工厂模式把更多的工作放到了接口实现方这边。对于“功能扩展”这项工作，抽象工厂模式可以分为产品扩展和产品族扩展两种。可以发现，产品的扩展其实违背了“开放-封闭原则”，因为它不但要修改工厂接口，还要修改每个现有的工厂实现类；而产品族的扩展则十分优雅，因为抽象工厂模式主打的就是扩展产品族嘛。