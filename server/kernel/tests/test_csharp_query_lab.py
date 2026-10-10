"""The differential probe must normalize only native REST serialization defaults."""
import importlib.util
from pathlib import Path
import unittest
from decimal import Decimal

spec = importlib.util.spec_from_file_location("query_lab", Path(__file__).resolve().parents[1] / "scripts/probes/highcode/csharp_query_lab.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class QueryResponseTests(unittest.TestCase):
    structures = {
        "AvOptional_Text": {"attributes": [{"name":"HasValue","type":"Boolean"},{"name":"Value","type":"Text"}]},
        "Row": {"attributes": [{"name":"Id","type":"Long Integer"},{"name":"Amount","type":"Decimal"},{"name":"Note","type":"AvOptional_Text"}]},
    }

    def test_omitted_defaults_are_not_borrowed_from_expected_values(self):
        value = probe.decode({"Id":9223372036854775001},"Row",self.structures)
        self.assertEqual(value,{"Id":"9223372036854775001","Amount":Decimal(0),"Note":None})
        self.assertNotEqual(value,{"Id":"9223372036854775001","Amount":Decimal(10),"Note":None})

    def test_null_empty_and_present_are_distinct_and_order_is_preserved(self):
        value = probe.decode([{}, {"HasValue":True}, {"HasValue":True,"Value":"x"}, {"Value":"stale"}],"AvOptional_Text List",self.structures)
        self.assertEqual(value,[None,"","x",None])

    def test_lossy_identifiers_and_invalid_presence_are_rejected(self):
        for value in (float(9223372036854775001),True):
            with self.assertRaises(ValueError): probe.decode(value,"Long Integer",self.structures)
        with self.assertRaises(ValueError): probe.decode({"HasValue":"false"},"AvOptional_Text",self.structures)
        with self.assertRaises(ValueError): probe.decode({"Unknown":1},"Row",self.structures)

    def test_unicode_fixture_bytes_preserve_normalization_and_quotes(self):
        for original in ("", "é", "e\u0301", "İ", "'", "\U0001f680", "\r\n"):
            sql = probe.sql_literal(original,"Text")
            encoded = sql.split("0x",1)[1].removesuffix(")")
            self.assertEqual(bytes.fromhex(encoded).decode("utf-16-le"),original)

    def test_runtime_binding_selects_calls_in_control_flow_not_user_values(self):
        token="IFrameworkIntrinsic:System.String.CompareOrdinal/1"
        call={"call":token,"as":"C"}
        literal={"assign":{"Message":token,"Record":{"call":token}}}
        graph={"actions":[{"steps":[literal,{"while":"True","do":[],"next":[call]}],
            "handlers":[{"steps":[{"switch":[{"when":"True","steps":[{"call":token}]}],"otherwise":[]}]}]}]}
        found=list(probe.runtime_call_steps(graph))
        self.assertEqual(len(found),2)
        for step in found: step["call"]="NativeTarget"
        self.assertEqual(literal["assign"]["Record"]["call"],token)
        self.assertFalse(list(probe.runtime_call_steps(graph)))

    def test_fixture_decimal_storage_never_rounds_the_oracle_inputs(self):
        self.assertEqual(probe.fixture_decimal_type([Decimal("12345678901234567890.123456789"),Decimal("0.000000001")]),"DECIMAL(29,9)")
        self.assertEqual(probe.fixture_decimal_type([Decimal("0.1"),Decimal("0.0000000000000000000000000001")]),"DECIMAL(28,28)")
        self.assertEqual(probe.fixture_decimal_type([Decimal("1e28"),Decimal("1e-28")]),"SQL_VARIANT")
        self.assertIn("DECIMAL(28,28)",probe.sql_literal(Decimal("1e-28"),"Decimal","SQL_VARIANT"))


if __name__ == "__main__":
    unittest.main()
