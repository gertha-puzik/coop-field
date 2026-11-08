# Imported models

The two source OBJ files were supplied for this project. They are retained in `source/` unchanged; each generated entry in `public/models/catalog.json` records its source object and SHA-256.

`python scripts/convert-obj-models.py` splits the tree collection into 200 independent GLB files and converts the origami cat. Geometry is Y-up, grounded at the feet/trunk, normalized to height 1, with flat normals. Original relative tree heights are retained in the catalog. GLBs have embedded geometry and vertex colors; there are no external texture requests.

The referenced MTL files were not supplied. The gray paper cat and natural green/brown tree palette are explicit fallback colors, not the missing original materials. PNG previews in `public/models/previews/` were rendered from these same GLBs with the Babylon camera and cropped to their alpha bounds. They are used by the library, 2D location editor and no-WebGL fallback.

Tree IDs `tree3d-001` through `tree3d-200` use the existing map object's `kind: tree` and `spr`. The server and client accept the same IDs; the old tree/rock IDs remain valid. `origami-cat` is a normal selectable player skin on both sides, with a GLB view only in Elision and a rendered sprite elsewhere. Placement, scale, rotation, collision bodies and map persistence use the existing systems.
