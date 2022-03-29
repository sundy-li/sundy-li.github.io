---
title: "探索Snowflake auto clustering 设计"
date: 2022-03-26T15:48:20+08:00
draft: false
tags: ["Snowflake", "database", "Cloud-native"]
categories: ["database"]
---

## Context

`Snowflake` IPO 大火之后，大家都开始慢慢了解到这个完全基于云计算设计的新式数据仓库。 `Snowflake` 的核心在于基于云端近似无限的计算存储资源，提供了极致弹性且高效的计算引擎 并且搭配 低成本且同样弹性伸缩的存储，大大减少了用户的心智负担和数据的计算存储成本，让用户更加专注于发挥数据对业务的价值。对于传统的数据仓库来说，`Snowflake` 就像一块降维打击的 二向箔。

在业务增长的过程中，客户的数据持续增长，从而导致单表变大，对大表的高效分析依赖于一套高性能的查询引擎。`Snowflake` 有一个非常核心的功能： `Auto Clustering`, 极大地提升了大表的查询效率。 我们这里主要探索下，`Snowflake` 的 `Auto Clustering` 功能是如何设计的。



## 什么是 Auto Clustering

> 注意: 这里的 Clustering 是指分组、聚类 的意思，注意不要理解为分布式、集群等概念。

Snowflake 的 Clustering 功能 和传统数据的 Partition 分区功能类似。但在传统的数据库系统中，大多依赖一些静态的分区规则来实现数据的物理隔离，如按时间，按用户特征hash等等，在hive等数据仓库中，最常见到的还是按照时间分区。当一个带有分区字段相关的查询过来的时候，分区的裁剪可以直接忽略掉不匹配的数据，这样就可以大大减少了数据的读取和计算量，从而提高查询性能。

静态分区用法非常简单，比如在Hive中：
```sql
-- Create Partition
ALTER TABLE table_name ADD PARTITION (dt='2020-03-26', hour='08') location '/path/table/20200326/08';
-- Then load data into the partition
```

但它有以下一些缺点：

- 开发人员在建表的时候必须知道数据的分布情况和将来面对的查询模式，增加了用户的心智负担。
- 静态分区的规则是固定的，但数据却是随时间在变化的，比如业务持续增长过程中，按天分区的表 新的分区会变大，从而导致分区分布不均匀。


Snowflake 在设计中 完全抛弃了 传统的静态`Partition` 的概念，而提出了 `Auto Clustering` 的新设计。简而言之，用户再也不用关心我的表是如何如何分区了，用户只管插入和查询就是了，数据分组，性能优化我会自动做!!!

# How ？

## Micro Partition (微分区)

虽然抛弃了静态分区，但snowflake 里面还是有 `Micro-Partition` 和 `Cluster Key` 的概念。

- `Cluster Key` 是排序键，可以由多个字段组成，类似ClickHouse 的  `Order Key`。
- `Micro-Partition` 是数据的基本组成单元，一个表的数据是由多个 `Micro-Partitions` 组成的。 我们可以将它理解为一个物理文件，这个物理文件限制在 50MB-500MB 的大小（未压缩），物理文件采用了列式存储，不同的列存储在不同的连续空间内。Snowflake 会存储 `Micro-Partition` 的信息到元数据服务中，方便查询的时候通过元数据索引进行剪枝，如：

	- 每个列的区间索引, 最大值最小值等 (ZoneMap index）
	- 列分布的直方图信息
	- 其他..

> 注： 鉴于`Micro-Partition` 的大小可能到500MB, 个人认为 `Micro-Partition` 的内部按道理应当划分类似Parquet的pages（clickhouse的mrk)，每个page有自己的索引，这样就可以在 `Micro-Partition`内部提高查询过滤的性能。不过看 Snowflake 目前的设计来说，微分区级别索引是最小粒度了，暂时没有微分区内部pages索引了，具体原因未知，文章末尾会提到个人的一些猜测。

## Clustered Tables

数据表建立后，默认数据是自然序，自然序意味着我们没有做任何处理，数据就按照流入的顺序排列，此时表处于 Unclustered 状态。当 表经历了 Clustering后，每个 `Micro-Partitions` 会按照指定的`key`进行排序, 可以理解为给表加了一个排序键，此时表处于 Clustered 状态。


![Cluster-Tables](/images/clustered-tables.png)

上图来自Snowflake文档。

 `Clustered` 的主要目的是让大部分的查询能高效的裁剪数据，避免不需要的IO读取和计算。

 举个例子：

 ```sql
 select name, country from t1 where type = 2 and date = '11/2';
 ```

在原始的数据排列中（自然序），上面的SQL会扫描到 *4个* 微分区。而在 `Clustered` 状态下，数据已经按照 `Cluster Key` -> `(date, type)` 进行排序，所以只会扫描到 *1个* 微分区，其他的微分区都被引擎结合了存储在元数据的索引进行了裁剪过滤。



## 怎样让表达到 Well-Clustered ？

一般来说，大表不会是静态的数据，大多会是时序数据，也就是说说数据不断地实时流入。因此，对整个表级别的数据全排序是非常不现实的，不仅代价较高，实时流入的数据也会影响全排序结果。另外一种方法是只对流入的数据进行排序，这样虽然新数据有比较好的顺序，但随着数据在不断地流入，数据整体的顺序会逐渐趋于混乱。

结合上面的分析，一个表如果能达到 ` Well-Clustered`（表数据的整体有序度高), 这样查询才能高效。在这个前提下，还需要保证 “新数据能实时高效流入“（确保DML高效），两者之间存在一个平衡点， Snowflake 的做法是 优先保证新数据能实时高效流入，新数据是不需要对数据整体的有序度 “负责”，因为新数据相比历史数据来说量级较小，影响的有序度也较小，它只需保证局部有序就行了（确保新数据查询也能高效）。新数据在后台会异步进行合并，保证 ”表数据的整体有序度高“，也就是说 *数据的整体有序是一个渐进的过程，而不是整体绝对有序的*。

## 如何衡量 Well-Clustered ？

Snowflake 引入了几个主要的指标来衡量表的 `Well-Clustered` 程度：

- Overlaps: 在一个Range范围内，有多少个 `Micro-Partitions` 有重叠
- Depth: 在一个数据点中，有多少个 `Micro-Partitions` 有重叠

![measuring-clustering](/images/measuring-clustering.png)

上面的图从上到下展示了四种 表 Cluster 的状态， 第一种情况是4个 微分区 完全重叠，这种情况是最糟糕的，因为它没有任何区分度，命中了A-Z这个Range的查询会不可避免地扫描四个分区。 随着Depth指标的下降，表中微分区变得逐渐离散， `Overlaps` 指标也在下降，表也逐渐变得更加 `Well-Clustered`。

当然，在实际的表分布中，微分区的分布要达到最下面那样规整（全局有序）是不现实的，因为所需要的开销太大了。

- levels：  微分区所属的级别

![cluster-level1](/images/cluster-level1.png)


为了减少写放大，微分区的合并策略和  `LSM-tree` 类似，微分区在后台不断地合并后形成新的微分区，每次合并完成后，微分区的 `Level` 值就会自增（clickhouse也有类似的 Part 合并逻辑），所以 `Level` 表示的就是微分区经历过的合并次数（用来衡量经历过的合并成本）。新数据流入的微分区 `Level` 默认是0，`Level` 越低的微分区中，`Overlaps` 和 `Depth` 指标相对来说会越高，在不断合并的过程中，微分区变得越来越离散，表也变得更加 `Well-Clustered`。

![cluster-level2](/images/cluster-level2.png)


> 注意： 微分区只会和同Level的微分区合并， Level 存在最大值，避免写放大太严重。

## Auto Clustering 是如何进行的？

`Auto Clustering` 主要分为两大任务:

- Part-Selection 任务
- Part-Merge 任务

这块和ClickHouse 的逻辑很类似，但明显的区别是 Snowflake 对云实在太偏爱了，上面所有的任务都可以在云端拉起独立的进程进行，而不需要占用用户的计算资源，并且这两个进程也是微服务化的，可以按需弹性伸缩。

### Part-Selection 任务

Selection 任务会从某个 `Level` 中选择出微分区列表集合，选择的策略是启发式的。

上面提到的2个指标可以构建一个启发式的算法：

1. Level 低的优先级的微分区被选择的优先级高，因此新流入的数据能有较高优先级合并到下个Level，Level越高的微分区除非在有充足的资源情况下，不会被合并。

2. Depth 高的微分区被选择的优先级高。

因此Selection的目标就是降低 `Level` 中微分区的平均深度，`AvgDepth`。

这里引入一个`AvgDepth`的计算逻辑：

下面四个微分区的情况下：
![Avg-Depth1](/images/avg-depth1.png)

我们对每个端点进行分析，如果没有overlap，depth忽略，因为depth的目的就是衡量overflap的程度，引入depth = 0会导致数据有偏差，此时depth表示一个端点覆盖了几个分区。
![Avg-Depth2](/images/avg-depth2.png)

最终的计算方式是：
```
AvgDepth = Sum(DepthOfOverflapPoint) / OverflapPointsCnt
```

Snowflake 没有公开具体的Selection算法，不过大概是 Level + AvgDepth 结合的一个公式进行排序，我们假设它是以 每个Level的AvgDepth排序选择某个Level，然后去顺序遍历此Level下的所有端点，超过了AvgDepth的连续端点会被选择作为Range。


![part-selection](/images/part-selection.png)


- 上面的曲线是如何构建的 ？

横轴对应的就是Key的Range， 纵轴表示 Depth，计算方式大概是：遍历所有的微分区，将微分区的 Range 的 Depth 进行求和 （即上面的 `DepthOfOverflapPoint` )，得出对应端点的 Y 值 （这里应该可以用差分数组的数据结构进行优化）

- 选择的策略是什么 ？

上图是选择了两个微分区列表的集合示例，选择的方式是顺序遍历所有的端点，如果端点的Depth超过了AvgDepth，就会被选择，连续选择的端点构成一个Range。


- 为什么不直接选最高的Depth ？

可以发现最高点 Depth 虽然最高，但 覆盖的Range 变窄，这样导致选择的微分区数量太小，对降低AvgDepth的影响较少。

- 选择的结果是什么 ？

看有多少个符合条件的波峰，上图是两个符合条件的波峰，这两个波峰互不重合，可以作为选择的结果集合，集合中内包含了微分区的 batches。


ClickHouse 中也有类似的[选择策略算法](https://github.com/ClickHouse/ClickHouse/blob/e9e77b44035d7f749a7833dca31c118afad25449/src/Storages/MergeTree/SimpleMergeSelector.h)，建议读者有时间也可以去了解下。




### Part-Merge 任务

接收到Selection的列表后，Part-Merge 可以独立地进行微分区的排序和合并，类似一个归并排序的过程。合并后的微分区就是一个全局有序的大微分区了。值得一提的是，合并后的分区如果超过了500MB的阈值上限，就会被分裂成更小的微分区，这和ClickHouse 存储一个大的分区文件 是不同的。

我猜测可能是：
1. Snowflake 和 ClickHouse不一样， 它不再维护微分区内部的稀疏索引， 稀疏索引的最小粒度就是微分区。
2. 在云端对象存储中，读取整个微分区 比 在微分区内部进行部分Range 虽然IO开销稍大，但差异不会太大， 而且对象存储一般都有对象级别的Cache，所以Snowflake的元数据只存储了微分区粒度的索引。

## 其他

- 系统函数：
	- [`system$clustering_depth`](https://docs.snowflake.com/en/sql-reference/functions/system_clustering_depth.html): 返回表平均的ClusteringDepth，可以指定 `columns` 参数
	- [`system$clustering_information`](https://docs.snowflake.com/en/sql-reference/functions/system_clustering_information.html): 返回表相关clustering 信息，包含 `average_overlaps`, `average_depth`, `partition_depth_histogram` 等

- 锁优化

Selection 和 Merge 进行不会对原始数据持有锁，也就是说在这两个过程中都不会卡主用户数据的查询和插入。这个优化其实很简单，就是在合并之后，持有对 合并涉及的微分区的锁，然后标记下新的微分区为Active状态，老的微分区为Outdate状态，异步GC删除，一些标志位的更新，涉及锁开销可以忽略不计。

- 自动合并服务

就是上面讲的 Selection 和 Merge 做成两个独立的服务异步运行。 Snowflake 旧版本提供了 手动 Cluster，后面废弃了，我猜测更多是让用户使用便捷，不用去Care Clustering这层操作，因为这些事情后台会自动做了，不当地频繁clustering反而增加了不必要的开销。

- 收费

虽然clustering没有用客户的计算资源，但收费还是要算在用户头上的，在 `Billing & Usage` 页面可以看到对应的计费情况。


相关配图，参考文章来源：

- [tables-clustering-micropartitions](https://docs.snowflake.com/en/user-guide/tables-clustering-micropartitions.html)
- [Automatic Clustering at Snowflake](https://medium.com/snowflake/automatic-clustering-at-snowflake-317e0bb45541)
- [How does automatic clustering work in Snowflake](https://www.linkedin.com/pulse/how-does-automatic-clustering-work-snowflake-minzhen-yang/)
- [zero-to-snowflake-automated-clustering-in-snowflake](https://interworks.com/blog/2020/05/28/zero-to-snowflake-automated-clustering-in-snowflake/)

















