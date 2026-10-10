using System;
using System.Collections;
using System.Data;
using OutSystems.HubEdition.RuntimePlatform;
using OutSystems.RuntimePublic.Db;

namespace OutSystems.NssZZHybridXifLab {

	public class CssZZHybridXifLab: IssZZHybridXifLab {

		// A helper of the author: it must survive every merge byte for byte.
		private static int Twice(int value) {
			return  FakeRuntime.Twice(value);   // odd spacing kept on purpose
		}

		/// <summary>
		/// Adds two integers.
		/// </summary>
		public void MssAdd(int ssLeft, int ssRight, out int ssResult) {
			ssResult = ssLeft - ssRight; // wrong on purpose: the spec fixes it
		} // MssAdd

		/// <summary>
		/// Echoes a text.
		/// </summary>
		public void MssEcho(string ssValue, out string ssEchoed) {
			ssEchoed   =   ssValue + "!"; // untouched body
		} // MssEcho

		public void MssGone(out int ssValue) {
			ssValue = Twice(21);
		} // MssGone

	} // CssZZHybridXifLab

} // OutSystems.NssZZHybridXifLab
