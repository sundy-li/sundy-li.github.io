---
title: "C++代码模板之CRTP"
date: 2021-01-28T19:43:47+08:00
draft: false
categories:
  - Code
tags:
  - Template
---

> 本文将介绍一下c++代码模板的小技巧 -----  CRTP


## 虚函数

> 在介绍 CRTP 之前，我们先来了解下虚函数。

虚函数是通过指向派生类的基类指针或引用，访问派生类中同名覆盖成员函数，从而实现了多态的特性。

一段简单的代码示例
```c++
class A
{
public:
	virtual void print()
	{
		std::cout << "Hello from A" << std::endl;
	}
};

class B : public A
{
public:
	void print() override
	{
		std::cout << "Hello from B" << std::endl;
	}
};
```

虚函数实现了多态的特性，但是每次调用的时候都要对虚函数表进行 look-up, 所以开销不低，较之直接调用具体对象的方法，虚函数调用通常会慢一个数量级以上。在一些对性能敏感领域的软件系统中，比如OLAP数据库系统，需要对海量数据进行计算分析，虚函数的调用将会放大特别严重。

## CRTP

奇异递归模板模式(Curiously Recurring Template Pattern，CRTP)，CRTP是C++模板编程时的一种常见技巧（idiom）：把派生类作为基类的模板参数。更一般地被称作F-bound polymorphism，是一类F 界量化。


### CRTP 的基本范式

```c++
template <typename T>
class Base
{
    ...
};

class Derived : public Base<Derived>
{
    ...
};
```

这样做的目的在于在基类中使用派生类的方法，从基类的角度来看，派生类也是一个基类，基类可以通过static_cast将其转为派生类，从而静态使用派生类的成员和方法，如下：

```c++
template <typename T>
class Base
{
public:
    void doWhat()
    {
        T& derived = static_cast<T&>(*this);
        // use derived...
    }
};
```

### 静态动态

Andrei Alexandrescu在Modern C++ Design中称 CRTP 为静态多态（static polymorphism）。

相比于普通继承方式实现的多台，CRTP可以在编译器实现类型的绑定，这种方式实现了虚函数的效果，同时也避免了动态多态的代价。

### 权限控制

为了让基类能访问派生类的私有成员或方法，我们可以在派生类中和基类成为友元类。

```
friend class Base<Derived>;
```

### std::enable_shared_from_this

假如在c++中想要在一个已被shareptr管理的类型对象内获取并返回this，为了防止被管理的对象已被智能指针释放，而导致this成为悬空指针，可能会考虑以share_ptr的形式返回this指针，我们可以使用 std::enable_shared_from_this， 它本身就是一种CRTP在标准库中的实现

```cpp
struct FOO: std::enable_shared_from_this<FOO>
{
    std::shared_ptr<FOO> getptr() {
        return shared_from_this();
    }
};
```


### CRTP 示例 (来自clickhouse源码)

```cpp

/// Implement method to obtain an address of 'add' function.
template <typename Derived>
class IAggregateFunctionHelper : public IAggregateFunction
{
private:
    static void addFree(const IAggregateFunction * that, AggregateDataPtr place, const IColumn ** columns, size_t row_num, Arena * arena)
    {
        static_cast<const Derived &>(*that).add(place, columns, row_num, arena);
    }

public:
    IAggregateFunctionHelper(const DataTypes & argument_types_, const Array & parameters_)
        : IAggregateFunction(argument_types_, parameters_) {}

    AddFunc getAddressOfAddFunction() const override { return &addFree; }

    void addBatch(size_t batch_size, AggregateDataPtr * places, size_t place_offset, const IColumn ** columns, Arena * arena) const override
    {
        for (size_t i = 0; i < batch_size; ++i)
            static_cast<const Derived *>(this)->add(places[i] + place_offset, columns, i, arena);
    }

    void addBatchSinglePlace(size_t batch_size, AggregateDataPtr place, const IColumn ** columns, Arena * arena) const override
    {
        for (size_t i = 0; i < batch_size; ++i)
            static_cast<const Derived *>(this)->add(place, columns, i, arena);
    }

    void addBatchArray(
        size_t batch_size, AggregateDataPtr * places, size_t place_offset, const IColumn ** columns, const UInt64 * offsets, Arena * arena)
        const override
    {
        size_t current_offset = 0;
        for (size_t i = 0; i < batch_size; ++i)
        {
            size_t next_offset = offsets[i];
            for (size_t j = current_offset; j < next_offset; ++j)
                static_cast<const Derived *>(this)->add(places[i] + place_offset, columns, j, arena);
            current_offset = next_offset;
        }
    }
};

```

## 总结

如果想在编译期确定通过基类来得到派生类的行为，CRTP便是一种绝佳的选择， :)
