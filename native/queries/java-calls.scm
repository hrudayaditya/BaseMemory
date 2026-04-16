; =============================================================
; Tree-sitter query for extracting function calls from Java
; =============================================================

; Direct method calls: foo(), process(1, 2)
(method_invocation
  name: (identifier) @callee.name) @call

; Object method calls: obj.method(), this.foo(), super.run()
(method_invocation
  object: (_)
  name: (identifier) @callee.name) @call

; Constructor calls: new Foo(), new ArrayList<>()
(object_creation_expression
  type: (type_identifier) @callee.name) @constructor

; Regular and static imports: import foo.Bar;, import static foo.Bar.baz;
(import_declaration
  (scoped_identifier
    name: (identifier) @import.name)) @import

(import_declaration
  (identifier) @import.name) @import
