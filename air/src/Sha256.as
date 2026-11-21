package
{
   import flash.utils.ByteArray;
   import flash.utils.Endian;

   /**
    * SHA-256 of a ByteArray, as lowercase hex. AIR has no digest API, and GameAssetCache checks
    * each downloaded game file against the content hash its name carries.
    */
   public final class Sha256
   {
      private static const K:Vector.<uint> = Vector.<uint>([
         0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
         0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
         0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
         0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
         0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
         0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
         0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
         0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ]);

      public static function hex(data:ByteArray) : String
      {
         var length:uint = data.length;
         // The message, a 1 bit, zeros, and the bit length as a 64-bit big-endian number.
         var padded:ByteArray = new ByteArray();
         padded.endian = Endian.BIG_ENDIAN;
         padded.writeBytes(data, 0, length);
         padded.writeByte(0x80);
         while ((padded.length % 64) != 56)
         {
            padded.writeByte(0);
         }
         padded.writeUnsignedInt(uint(Math.floor(length / 0x20000000)));
         padded.writeUnsignedInt(uint((length * 8) >>> 0));
         padded.position = 0;

         var h0:uint = 0x6a09e667, h1:uint = 0xbb67ae85, h2:uint = 0x3c6ef372, h3:uint = 0xa54ff53a;
         var h4:uint = 0x510e527f, h5:uint = 0x9b05688c, h6:uint = 0x1f83d9ab, h7:uint = 0x5be0cd19;
         var w:Vector.<uint> = new Vector.<uint>(64, true);
         var k:Vector.<uint> = K;
         var a:uint, b:uint, c:uint, d:uint, e:uint, f:uint, g:uint, h:uint;
         var s0:uint, s1:uint, t1:uint, t2:uint, x:uint, i:int;
         var blocks:uint = padded.length / 64;
         for (var block:uint = 0; block < blocks; block++)
         {
            for (i = 0; i < 16; i++)
            {
               w[i] = padded.readUnsignedInt();
            }
            for (i = 16; i < 64; i++)
            {
               x = w[i - 15];
               s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
               x = w[i - 2];
               s1 = ((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10);
               w[i] = uint(w[i - 16] + s0 + w[i - 7] + s1);
            }
            a = h0; b = h1; c = h2; d = h3; e = h4; f = h5; g = h6; h = h7;
            for (i = 0; i < 64; i++)
            {
               s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
               t1 = uint(h + s1 + ((e & f) ^ (~e & g)) + k[i] + w[i]);
               s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
               t2 = uint(s0 + ((a & b) ^ (a & c) ^ (b & c)));
               h = g; g = f; f = e;
               e = uint(d + t1);
               d = c; c = b; b = a;
               a = uint(t1 + t2);
            }
            h0 = uint(h0 + a); h1 = uint(h1 + b); h2 = uint(h2 + c); h3 = uint(h3 + d);
            h4 = uint(h4 + e); h5 = uint(h5 + f); h6 = uint(h6 + g); h7 = uint(h7 + h);
         }
         return word(h0) + word(h1) + word(h2) + word(h3) + word(h4) + word(h5) + word(h6) + word(h7);
      }

      private static function word(value:uint) : String
      {
         var text:String = value.toString(16);
         while (text.length < 8)
         {
            text = "0" + text;
         }
         return text;
      }
   }
}
