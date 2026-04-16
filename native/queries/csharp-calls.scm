; =============================================================
; Tree-sitter query for extracting function calls from C#
; =============================================================

; Direct calls: Method(), Helper()
(invocation_expression
  function: (identifier) @callee.name) @call

; Member access calls: obj.Method(), this.Foo()
(invocation_expression
  function: (member_access_expression
    name: (identifier) @callee.name)) @call

; Generic method calls: Run<int>(), obj.Method<T>()
(invocation_expression
  function: (generic_name
    (identifier) @callee.name)) @call

(invocation_expression
  function: (member_access_expression
    name: (generic_name
      (identifier) @callee.name))) @call

; Constructor calls: new Foo(), new List<int>(), new Namespace.Type()
(object_creation_expression
  type: (identifier) @callee.name) @constructor

(object_creation_expression
  type: (generic_name
    (identifier) @callee.name)) @constructor

(object_creation_expression
  type: (qualified_name
    name: (identifier) @callee.name)) @constructor

; Using directives
(using_directive
  name: (identifier) @import.name) @import

(using_directive
  (qualified_name
    name: (identifier) @import.name)) @import
