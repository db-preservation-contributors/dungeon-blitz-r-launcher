package
{
   import flash.display.Loader;
   import flash.external.ExternalInterface;
   import flash.net.URLRequest;
   import flash.system.LoaderContext;
   import flash.system.Security;

   /**
    * The AIR engine's own copy of the game's AirCompat class.
    *
    * DungeonBlitz.swf carries an AirCompat (the game server's scripts/air-compat/AirCompat.as),
    * and the game calls it to load every level and art SWF. The game runs in a child of this app's
    * ApplicationDomain, and a class the parent domain already defines wins over the child's own
    * definition, so while this class is in the parent the game's calls land here. Load then goes
    * through GameAssetCache: files kept on disk by content hash, one download per file however
    * often the game restarts it.
    *
    * This is only safe while it has the same public API as the game's copy. DungeonBlitzAir checks
    * that the game SWF carries SOURCE_DIGEST (the digest of the AirCompat.as the server compiled
    * in) and otherwise runs the game where this class cannot reach it. When the server's
    * AirCompat.as changes, copy its API here and set SOURCE_DIGEST to the new digest
    * (`AirCompat.SOURCE_DIGEST` in a decompile of the new DungeonBlitz.swf).
    */
   public class AirCompat
   {
      /** The game's AirCompat this copy stands in for. */
      public static const SOURCE_DIGEST:String = "778489d13c4bfb12";

      public static function InAir() : Boolean
      {
         return Security.sandboxType == "application";
      }

      public static function Load(loader:Loader, request:URLRequest, context:LoaderContext) : void
      {
         if (!InAir())
         {
            loader.load(request, context);
            return;
         }
         GameAssetCache.load(loader, request, context);
      }

      public static function allowDomain(... domains) : void
      {
         if (!InAir())
         {
            Security.allowDomain.apply(null, domains);
         }
      }

      public static function call(name:String, ... args) : *
      {
         if (!ExternalInterface.available)
         {
            return null;
         }
         return ExternalInterface.call.apply(null, [name].concat(args));
      }
   }
}
