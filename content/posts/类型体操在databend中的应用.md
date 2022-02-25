---
title: "类型体操在databend中的应用"
date: 2022-02-25T11:21:28+08:00
draft: false
categories:
  - database
  - databend
---


> 春节期间花了前后一个月时间终于重构完了databend的datavalues模块，本文将介绍在新的datavalues系统中是如何使用类型体操的。

## Context

在旧版本的datavalues模块中，我们要编写函数通常需要写很多冗余的代码 加上各种宏结合，代码看起来非常繁琐，比如 [in函数的实现](https://github.com/datafuselabs/databend/blob/v0.6.49-nightly/common/functions/src/scalars/udfs/in_basic.rs)：

除了上面的例子，缺点还有：

-  Column是一个enum类型，包含Constant 和 Series(一个ArrayTrait，可以理解为 `Arc<dyn Array>`).
```
pub enum DataColumn {
    // Array of values.
    Array(Series),
    // A Single value.
    Constant(DataValue, usize),
}
```

Constant 列在列式系统中是非常有必要的，它表示列是一个常量值，比如 `number + 3`, `3` 就是一个常量列，向量化计算中它会和number列中对应行位置数值进行相加。 常量列可以在runtime计算中节省内存分配回收的开销，在一些特殊的算子中，常量列可以提高不少性能，如 `rem by scalar`。

为此，我们旧版本的函数计算通常都需要每个地方加入各种 match 来匹配常量列的情况，这样会导致代码的繁琐，而且还会导致代码的可读性差。如果函数的参数非常多，会导致 match 满天飞的情况出现，比如 [export_set函数](https://github.com/datafuselabs/databend/blob/v0.6.49-nightly/common/functions/src/scalars/strings/export_set.rs#L91-L253)。 常量列虽然也可以通过 `to_array` 方法物化成普通列，物化意味着内存的开销，虽然提高了可读性，但影响了性能。

- 无法通过 scalar 函数来自动形成向量化的函数：

比如 comparison 函数，我们需要为 `10个基础类型` + `bool 类型` +  `String 类型`的 列运用此函数。 即使我们有一种非常精简的标量函数实现， `fn cmp(a: S, b: S) {a.cmp(b)}`，也不能自动形成向量化的函数。 根本的原因在于没有将列类型和标量类型在编译期间就进行绑定。


## 尝试

在ClickHouse 或者 Velox等c++ 项目中，这个绑定用一些template技巧就可以很好的解决，但在Rust中，我们需要开启不稳定的GAT特性，既然要绑定的话，那一个雏形大概是：

- ScalarColumn 的定义
```
pub trait ScalarColumn: Column + Send + Sync + Sized + 'static {
	type OwnedItem: Scalar<ColumnType = Self>;
	fn value_at(&self, index: usize) -> Self::OwnedItem;
}
```

- Scalar 类型的定义：


```
pub trait Scalar: 'static + Sized + Default + Any
{
    type ColumnType: ScalarColumn<OwnedItem = Self>;
}
```

然后我们为  `10个基础类型` + `bool 类型` +  `String 类型` 都加上 `Scalar`的实现，此处省略一堆macros。

理想很美满，但现实非常悲惨。

- value_at 返回了对应索引的Scalar值，如果是 `10个基础类型`， 我们可以返回引用或者值， 如果是 `String` 类型, 我们返回值意味着每次访问都有一次内存copy，这在列式计算中是开销是非常大的，于是我决定修改 `value_at`方法，统一返回引用：

```
fn value_at(&self, index: usize) -> &Self::OwnedItem;
```

但 `Boolean` 类型，我们是无法返回引用的，因为在内存模型中， `Boolean` 列是一个bitmap实现，没有Owner到boolean值，`value_at`方法必须返回值。

要解决这个问题，我想到了两个思路：

- 一种是通过unsafe + 锁的方式往这个 BooleanColumn 里面去物化一个 `Vec<bool>`，这样就可以返回引用了, 这个unsafe 略显trick。
- 第二种是将 `BooleanColumn` 直接用 `Vec<u8>`存储，但这样和arrow转换内存数据时会有额外的内存copy开销。

为此陷入了一些误区，让组里的同学也帮忙想想好的解决思路，但一直没有理想的解决方案。

## 巧遇type-exercise

此事搁置后不久，在github刷到了迟先生开源的 [类型体操](https://github.com/skyzh/type-exercise-in-rust)，犹如醍醐灌顶，原来 Rust 还可以这么玩，我怎么没有想到可以绑定 一种引用类型呢？

如果读者没有看过迟先生类型体操项目，强烈推荐去阅读下，同时还有[配套知乎专栏](https://zhuanlan.zhihu.com/p/460977012) 服务。

下面介绍下 类型体操 在databend中是如何运用的。



## Databend 应用类型体操

和开源的 `type-exercise` 稍有不同，我们的中心是 `Scalar` 类型，而不是 `Column` 类型。

![type-exercise](/images/types.jpg)


详见[代码](https://github.com/datafuselabs/databend/blob/dc058c9d22baa9e61763661f77cd10ec62c87c48/common/datavalues/src/scalars)

## 实现

Scalar, ScalarRef， ScalarColumn 的定义和开源版本差不多，这里不再赘述。
这里着重讲讲一些不同之处：

- ScalarColumn 无需考虑nullable的存在， nullable 我们在外层会进行统一处理（bitmap取与操作），特殊情况我们可以用 后面讲到的 ScalarViewer 来解决。

- 由于不需要考虑nullable，column生成的迭代器可以利用 `slice.iter()`,省去了各种bound check的开销，并且无需option封装，省去了分支预测的开销，便于循环中计算的pipeline计算或编译器的自动优化。

- Scalar 和 ScalarRef 以及 ScalarColumn  有绑定，ScalarRef 和 ScalarColumn 也有绑定， 但是我们需要告诉编译器ScalarColumn中的ScalarRef 和 Scalar中的ScalarRef 是同一个ScalarRef （有点绕），因此我们加了一个额外的 [限定](https://github.com/skyzh/type-exercise-in-rust/commit/56f4daaca1aee38aa894b0067fe8bf7895aff427)

```rust
  pub trait Scalar: 'static + Sized + Default + Any
+ where for<'a> Self::ColumnType: ScalarColumn<RefItem<'a> = Self::RefType<'a>>
+ {
```

这样一来，我们绑定在ScalarColumn上的类型和绑定在Scalar上的类型就已经产生了级联联动。

- 以Scalar为中心的 [`UnaryExpression` 实现](https://github.com/datafuselabs/databend/blob/dc058c9d22baa9e61763661f77cd10ec62c87c48/common/functions/src/scalars/expressions/unary.rs):

ScalarUnaryFunction 类型：

```rust

pub trait ScalarUnaryFunction<L: Scalar, O: Scalar> {
    fn eval(&self, l: L::RefType<'_>, _ctx: &mut EvalContext) -> O;
}

/// Blanket implementation for all binary expression functions
impl<L: Scalar, O: Scalar, F> ScalarUnaryFunction<L, O> for F
where F: Fn(L::RefType<'_>, &mut EvalContext) -> O
{
    fn eval(&self, i1: L::RefType<'_>, ctx: &mut EvalContext) -> O {
        self(i1, ctx)
    }
}
```

ScalarUnaryExpression:

```rust

/// A common struct to caculate Unary expression scalar op.
#[derive(Clone)]
pub struct ScalarUnaryExpression<L: Scalar, O: Scalar, F> {
    f: F,
    _phantom: PhantomData<(L, O)>,
}

impl<'a, L: Scalar, O: Scalar, F> ScalarUnaryExpression<L, O, F>
where F: ScalarUnaryFunction<L, O>
{
    /// Create a Unary expression from generic columns  and a lambda function.
    pub fn new(f: F) -> Self {
        Self {
            f,
            _phantom: PhantomData,
        }
    }

    /// Evaluate the expression with the given array.
    pub fn eval(
        &self,
        l: &'a ColumnRef,
        ctx: &mut EvalContext,
    ) -> Result<<O as Scalar>::ColumnType> {
        let left = Series::check_get_scalar::<L>(l)?;
        let it = left.scalar_iter().map(|a| (self.f).eval(a, ctx));
        let result = <O as Scalar>::ColumnType::from_owned_iterator(it);

        if let Some(error) = ctx.error.take() {
            return Err(error);
        }
        Ok(result)
    }
}
```

上面的 EvalContext 是为了存储计算过程中可能出现的Error， 借助 `ScalarUnaryExpression`的封装， 我们就可以自动将标量函数的实现转为向量化的实现了，示例：

[向量化hash函数](https://github.com/datafuselabs/databend/blob/fe84f5e40f4ac96306ef71618ade9171d865ea81/common/functions/src/scalars/hashes/hash_base.rs):

```rust
fn hash_func<H, S, O>(l: S::RefType<'_>, _ctx: &mut EvalContext) -> O
where
    S: Scalar,
    O: Scalar + FromPrimitive,
    H: Hasher + Default,
    for<'a> <S as Scalar>::RefType<'a>: DFHash,
{
    let mut h = H::default();
    l.hash(&mut h);
    O::from_u64(h.finish()).unwrap()
}
...

fn eval(
        &self,
        columns: &common_datavalues::ColumnsWithField,
        _input_rows: usize,
) -> Result<common_datavalues::ColumnRef> {
	with_match_scalar_types_error!(columns[0].data_type().data_type_id().to_physical_type(), |$S| {
		let unary = ScalarUnaryExpression::<$S, R, _>::new(hash_func::<H, $S, R>);
		let col = unary.eval(columns[0].column(), &mut EvalContext::default())?;
		Ok(Arc::new(col))
	})
}

```

同理，我们可以实现 以 Scalar 为中心的 [`ScalarBinaryExpression`](https://github.com/datafuselabs/databend/blob/dc058c9d22baa9e61763661f77cd10ec62c87c48/common/functions/src/scalars/expressions/binary.rs), 由于有Constant的存在，实现稍显复杂，因为需要match 四种情况， 不过我们都封装在 `ScalarBinaryExpression` 内部，函数实现无需重复match，示例：

```rust
#[test]
fn test_binary_contains() {
    //create two string columns
    struct Contains {}

    impl ScalarBinaryFunction<Vu8, Vu8, bool> for Contains {
        fn eval(&self, a: &'_ [u8], b: &'_ [u8], _ctx: &mut EvalContext) -> bool {
            a.windows(b.len()).any(|window| window == b)
        }
    }

    let binary_expression = ScalarBinaryExpression::<Vec<u8>, Vec<u8>, bool, _>::new(Contains {});

    for _ in 0..10 {
        let l = Series::from_data(vec!["11", "22", "33"]);
        let r = Series::from_data(vec!["1", "2", "43"]);
        let expected = Series::from_data(vec![true, true, false]);
        let result = binary_expression
            .eval(&l, &r, &mut EvalContext::default())
            .unwrap();
        let result = Arc::new(result) as ColumnRef;
        assert!(result == expected);
    }
}
```


## 进阶

虽然有 `Unary` 和 `Binary` 两种Expression的封装， 不过有的函数参数众多，单目和双目 表达式都无法覆盖。在这种情况下，我们仍然无法避免对Constant 情况 进行match，这里我们对类型体操进行了扩充，引入了 `ScalarViewer`的概念，它可以处理 nullable 和 constant 两种特殊的column，并且提供统一的API封装。

- ScalarViewer 和 Scalar 可以相互绑定，它还可以绑定一个迭代器，同时提供按索引取值和判断null的操作。

```rust
pub trait ScalarViewer<'a>: Clone + Sized {
    type ScalarItem: Scalar<Viewer<'a> = Self>;
    type Iterator: Iterator<Item = <Self::ScalarItem as Scalar>::RefType<'a>>
        + ExactSizeIterator
        + TrustedLen;

    fn try_create(col: &'a ColumnRef) -> Result<Self>;

    fn value_at(&self, index: usize) -> <Self::ScalarItem as Scalar>::RefType<'a>;

    fn valid_at(&self, i: usize) -> bool;

    /// len is implemented in ExactSizeIterator
    fn size(&self) -> usize;

    fn null_at(&self, i: usize) -> bool {
        !self.valid_at(i)
    }

    fn is_empty(&self) -> bool {
        self.size() == 0
    }

    fn iter(&self) -> Self::Iterator;
}
```

一个 ScalarViewer的实现：

```rust
#[derive(Clone)]
pub struct PrimitiveViewer<'a, T: PrimitiveType> {
    pub(crate) values: &'a [T],
    // for not nullable column, it's 0. we only need keep one sign bit to tell `null_at` that it's not null.
    // for nullable column, it's usize::max, validity will be cloned from nullable column.
    pub(crate) null_mask: usize,
    // for const column, it's 0, `value` function will fetch the first value of the column.
    // for not const column, it's usize::max, `value` function will fetch the value of the row in the column.
    pub(crate) non_const_mask: usize,
    pub(crate) size: usize,
    pub(crate) pos: usize,
    pub(crate) validity: Bitmap,
}

```

这里引入了两种 位操作掩码的技巧:
- `null_mask`, 如果column是非nullable或者constant的，那么 `null_mask` 就是0，如果是nullable的，那么 `null_mask` 就是 usize::max
- `non_const_mask`: 如果column是constant的，那么 `non_const_mask` 就是0，如果是非constant的，那么 `non_const_mask` 就是 usize::max

有了两个掩码后，我们可以运用位操作来减少一个if判断的开销:

```rust
#[inline]
fn value_at(&self, index: usize) -> T {
	self.values[index & self.non_const_mask]
}

#[inline]
fn valid_at(&self, i: usize) -> bool {
	unsafe { self.validity.get_bit_unchecked(i & self.null_mask) }
}
```


- Viewer迭代器：

Viewer迭代器的实现就是将 Viewer 的index置为0，然后clone一次

```rust
fn iter(&self) -> Self {
	let mut res = self.clone();
	res.pos = 0;
	res
}

// 实现 Iterator trait
fn next(&mut self) -> Option<Self::Item> {
	if self.pos >= self.size {
		return None;
	}

	let old = self.pos;
	self.pos += 1;

	Some(unsafe { *self.values.as_ptr().add(old & self.non_const_mask) })
}
```

- 自定义迭代器一定不要忘记实现 TrustedLen， 提高迭代器遍历生成Vec的性能:

```rust
unsafe impl<'a, T> TrustedLen for PrimitiveViewer<'a, T>
where
    T: Scalar<Viewer<'a> = Self> + PrimitiveType,
    T: ScalarRef<'a, ScalarType = T>,
    T: Scalar<RefType<'a> = T>,
{
}


impl<'a, T> ExactSizeIterator for PrimitiveViewer<'a, T>
where
    T: Scalar<Viewer<'a> = Self> + PrimitiveType,
    T: ScalarRef<'a, ScalarType = T>,
    T: Scalar<RefType<'a> = T>,
{
    fn len(&self) -> usize {
        self.size - self.pos
    }
}

```

最后来个viewer引用的示例, [concat_ws 实现](https://github.com/datafuselabs/databend/blob/fe84f5e40f4ac96306ef71618ade9171d865ea81/common/functions/src/scalars/strings/concat_ws.rs)：

```rust
let viewers = columns
	.iter()
	.map(|column| Vu8::try_create_viewer(column.column()))
	.collect::<Result<Vec<_>>>()?;

let mut builder = MutableStringColumn::with_capacity(rows);
let mut buffer: Vec<u8> = Vec::with_capacity(32);
(0..rows).for_each(|row| {
	buffer.clear();
	for (idx, viewer) in viewers.iter().enumerate() {
	if !viewer.null_at(row) {
		if idx > 0 {
		buffer.extend_from_slice(sep);
		}

		buffer.extend_from_slice(viewer.value_at(row));
	}
	}
	builder.append_value(buffer.as_slice());
});
Ok(builder.to_column())
```

## 过程宏

Tikv中引入了一个非常复杂的过程宏来生产向量化函数表达式，在databend中有过类似的尝试，但由于过程宏的实现过于复杂，自定义函数虽然代码量稍多，但会比较灵活，可读性以及维护性都比较好，所以我们这里没有使用过程宏。

## 总结

经过type-exercise的改造后，聚合函数和标量函数的计算终于可以以非常精简的方式实现了，最后特别感谢迟先生的体操教程以及在这个过程中给出的建议，tql！！！

