# Owned native-signature fixture

`ordinal-primitive.avsig` is public signature metadata generated for the SSAM laboratory extension `ZZHighCodePrimitives`. It contains one typed function, `CSharpTextCompareOrdinal(Text Left, Text Right) -> Integer Result`, implemented by our source as `System.String.CompareOrdinal(Left, Right)`.

The fixture contains neither an executable assembly nor vendor implementation code. Its host was replaced by `fixture.invalid`; native import tests run offline against the frozen signature. Production delivery must acquire its signature from the actual authorized environment. A passing import test does not certify runtime behavior or establish a product dependency on this laboratory extension.
