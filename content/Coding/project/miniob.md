---
title: MinoOB 部分架构实现
date: 2026-06-25
tags: [数据库基础]
summary: MiniOb比赛的部分赛题实现。
---

**前言：**最近由于作业需要做了个oceanbase，这里略微对做了的题目的一部分做个记录。

# 执行流程
miniob的执行流程大概是这样的：

```python
sql 语句 -> parser(get SqlNode) -> stmt generator(get stmt) -> optimzer 
-> logical plan(get logical tree) -> physical plan(get physical tree)
```

自底向上地执行 physical tree 上的各个算子，实现 sql 逻辑。下面是一个树的示意。

```python
    project
        |
    predicate
        |
    group by
        |
    order by
        |
    join table
    |			|
table scan   table scan
```

对于树上的每个算子，有 open，next，close 等方法，通过 next去递归执行算子。

# 关于如何插入和读取数据
首先依然还是语法解析部分，我们需要定义 insert 的语法解析规则:

```cpp
// 这里我们需要知道要插入的表的名称： realtion-name
// 需要知道插入的字段 values，一个values包括其类型，值等
struct InsertSqlNode
{
  string        relation_name;  ///< Relation to insert into
  vector<Value> values;         ///< 要插入的值
};


```

```cpp
insert_stmt:        /*insert   语句的语法解析树*/
    INSERT INTO ID VALUES LBRACE value value_list RBRACE 
    {
      $$ = new ParsedSqlNode(SCF_INSERT);
      $$->insertion.relation_name = $3;
      if ($7 != nullptr) {
        $$->insertion.values.swap(*$7);
        delete $7;
      }
      $$->insertion.values.emplace_back(*$6);
      reverse($$->insertion.values.begin(), $$->insertion.values.end());
      delete $6;
    }
    ;
```

语法解析后，我们需要创建插入的stmt：

```cpp
RC InsertStmt::create(Db *db, const InsertSqlNode &inserts, Stmt *&stmt)
{ ...
}
```

接下来就是创建logical plan和physical plan。

在 physical plan 中进行值的存储时，我们将逻辑上的 Value，变成二进制的 record 存入内存之中：

```cpp
RC InsertPhysicalOperator::open(Trx *trx)
{
  Record record;
  RC     rc = table_->make_record(static_cast<int>(values_.size()), values_.data(), record);
  if (rc != RC::SUCCESS) {
    LOG_WARN("failed to make record. rc=%s", strrc(rc));
    return rc;
  }

  rc = trx->insert_record(table_, record);
  if (rc != RC::SUCCESS) {
    LOG_WARN("failed to insert record by transaction. rc=%s", strrc(rc));
  }
  return rc;
}

//-------- table->make_record()
rc = set_value_to_record(record_data, value, field);
```

## 支持null的插入
语法解析和stmt部分的修改自然不用说。对于一个值，如果他是null，需要在record中额外存储。这里可以在record前添加字段 null_bitmap:

为了实现这个逻辑，首先需要修改 table_meta, 这里存储了一个数据库表的每一行需要占用的内存大小 record_size。之前我只在make record时给record扩展了null字段的内存，结果发现插入和读取时，record的大小还是增加null字段前，导致如果插入的数据较长，溢出的部分就会被覆盖。

```cpp
int user_field_num  = this->field_num() - sys_field_num(); 
int null_bitmap_size = (user_field_num + 7) / 8; 
record_size_ = record_size_ + null_bitmap_size;
```

在make record部分，只需要对 null 字段和 数据字段分别处理就好。

```cpp
int   record_size = table_meta_.record_size();
char *record_data = (char *)malloc(record_size);
memset(record_data, 0, record_size);

// 遍历每个字段
  for (int i = 0; i < value_num && OB_SUCC(rc); i++) {
    const FieldMeta *field = table_meta_.field(i + normal_field_start_index);
    const Value     &value = values[i];

    // 1. 设置 NULL bitmap 标志位
    if (value.is_null()) {
      int byte_index = i / 8;
      int bit_index  = i % 8;
      null_bitmap[byte_index] |= (1 << bit_index);  // 置 1 表示 NULL
      continue; // 不写入数据
    }

    // 2. 非 NULL 正常写值
    if (field->type() != value.attr_type()) {
      Value real_value;
      rc = Value::cast_to(value, field->type(), real_value);
      if (OB_FAIL(rc)) {
        LOG_WARN("failed to cast value. table name:%s, field name:%s, value:%s",
                 table_meta_.name(), field->name(), value.to_string().c_str());
        break;
      }
      rc = set_value_to_record(record_data + null_bitmap_size, real_value, field);
    } else {
      rc = set_value_to_record(record_data + null_bitmap_size, value, field);
    }
  }
```

注意，这里在对record进行赋值时，需要做偏移。如下面所示。假设原本一张表有两个字段，在物理中存储一个字段4个bit。现在我们额外添加了2个字段表示后面的字段是否是null，因此在使用 memcpy 去赋值时，我们起始的位置是要在原来的基础上偏移 null_bitmap_size 的，这也是为什么 set_value_to_record(record_data + null_bitmap_size, real_value, field)。

```cpp
record_without_null:
   0000 | 0000 
record_with_null:
  00 | 0000 | 0000
```

## 支持 null 的读取和修改
在读取record时，我们同样也要对 null_bitmap 和 value部分分别读取：

```cpp
    const char *record_data = this->record_->data();
    const TableMeta &table_meta = field_expr->field().table()->table_meta();
    int sys_field_num   = table_meta.sys_field_num();
    int user_field_num  = table_meta.field_num() - sys_field_num;
    int null_bitmap_size = (user_field_num + 7) / 8;
    const unsigned char *null_bitmap = reinterpret_cast<const unsigned char *>(record_data);

    int field_index = field_meta->field_id() - sys_field_num;

    if (field_index >= 0 && field_index < user_field_num) {
      int byte_index = field_index / 8;
      int bit_index  = field_index % 8;
      bool is_null = (null_bitmap[byte_index] >> bit_index) & 0x01;

      if (is_null) {
        cell.set_null();
        return RC::SUCCESS;
      }

    }
    
    const char *field_data_start = record_data + null_bitmap_size + field_meta->offset();
    cell.set_data((char *)field_data_start, field_meta->len());
```

# 关于如何做 select / order by...
## Order by
**整体思路：**

orderby的思路比较直接，在group by后挂一个算子。遍历 group by 后的所有的元组，将其值保存在一个数组中，调用 sort 方法将其排序。然后通过一个索引size_t和有序数组tuples_去实现current_tuple的调用。

**实现：**

首先是此法解析部分，系统需要识别输入的关键token “order by”

```cpp
ORDER                                   RETURN_TOKEN(ORDER); // 
ASC                                     RETURN_TOKEN(ASC); // 
DESC                                    RETURN_TOKEN(DESC); // 
```

接下来是语法解析部分。为了实现order by，我们至少应该保留用于排序的字段，是否降序这两个关键信息。

我们将其保存为：

```cpp
struct OrderbySqlNode 
{
  std::unique_ptr<Expression> expression; // 要排序的字段
  bool      is_desc; // 是否是逆序
};

struct SelectSqlNode
{
  vector<unique_ptr<Expression>> expressions;  ///< 查询的表达式
  vector<string>                 expr_aliases;
  TableRefList                   relations;   ///< 查询的表
  vector<ConditionSqlNode>       conditions;  ///< 查询条件，使用AND串联起来多个条件
  vector<unique_ptr<Expression>> group_by;    ///< group by clause
  vector<OrderbySqlNode>         orderby_list; //< 需要排序的字段
};

```

语法解析时，我们需要从sql语句中解析出用于orderby的字段序列以及是否降序的序列。这里我们的语法解析方法如下：

```cpp
select_stmt:        /*  select 语句的语法解析树*/
    SELECT select_list FROM table_ref_list where group_by orderby_list // 
      if ($7 != nullptr) {  // yr
        $$->selection.orderby_list.swap(*$7);
        delete $7;
      }
    ;


orderby_list:  
    /* empty */
    {
      $$ = nullptr;
    }
    | ORDER BY orderby {
      $$ = new vector<OrderbySqlNode>;
      $$->emplace_back(std::move(*$3));
      delete $3;
    }
    | orderby_list COMMA orderby {
      $$ = $1;
      $$->emplace_back(std::move(*$3));
      delete $3;
    }

orderby:  
    expression {
      $$ = new OrderbySqlNode;
      $$->expression = std::unique_ptr<Expression>($1);;
      $$->is_desc    = false;
    }
    | expression ASC {
      $$ = new OrderbySqlNode;
      $$->expression = std::unique_ptr<Expression>($1);;
      $$->is_desc    = false;
    }
    | expression DESC {
      $$ = new OrderbySqlNode;
      $$->expression = std::unique_ptr<Expression>($1);;
      $$->is_desc    = true;
    }


```

语法解析完成后，我们需要处理得到对应的 stmt：

```cpp
RC SelectStmt::create(Db *db, SelectSqlNode &select_sql, Stmt *&stmt)
{
// ...
// create orderby statement yr
  vector<unique_ptr<Expression>> orderby_list_expression;
  vector<bool>  orderby_list_isDesc;
  for(auto &orderby : select_sql.orderby_list){
    RC  rc = expression_binder.bind_expression(orderby.expression, orderby_list_expression);
    if (OB_FAIL(rc)) {
      LOG_INFO("bind expression failed. rc=%s", strrc(rc));
      return rc;
    }
    orderby_list_isDesc.emplace_back(orderby.is_desc);
  }
// ...
    }
```

之后创建 logical plan 和 physical plan 可以完全模仿 grouo by 的实现。

关于 orderby operator 物理算子的实现，首先遍历所有子节点将值存下来，再去排序。后续访问时利用size_t和tuples_去实现（每次next就更新size_t）：

```cpp

RC OrderByPhysicalOperator::open(Trx *trx)
{   
    
    RC rc = RC::SUCCESS;

    tuple_idx_ = 0;
    
    if(children_.empty()){
        return rc;
    }

    // get all tuples
    PhysicalOperator *child = children_[0].get();
    rc = child->open(trx);
    
    while ((rc = child->next()) == RC::SUCCESS)
    {  
       ValueListTuple tuple;
       ValueListTuple::make(*child->current_tuple(), tuple);
       tuples_.push_back(std::make_unique<ValueListTuple>(tuple));
    }
    
    // sort
    std::sort(tuples_.begin(), tuples_.end(),
    ...);

    return RC::SUCCESS;
}

RC OrderByPhysicalOperator::next()
{
    if (tuple_idx_ >= tuples_.size()) {
        return RC::RECORD_EOF;
    }
    tuple_idx_++;
    return RC::SUCCESS;
}

Tuple *OrderByPhysicalOperator::current_tuple()
{
    if (tuple_idx_ == 0 || tuple_idx_ > tuples_.size()) {
        return nullptr;
    }
    return tuples_[tuple_idx_ - 1].get();
}



```



