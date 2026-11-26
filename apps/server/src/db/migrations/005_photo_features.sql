-- Search keys of a photo's local features, so "Check a photo" finds a cropped,
-- mirrored, turned or screenshotted copy. feature_keys holds 8 keys for each
-- feature, in feature order; feature_x / feature_y hold one position for each
-- feature, in sixteenths of a pixel of the photo's check frame. NULL: a photo
-- from before this migration (run dist/backfill-features.js) or a deleted one.
-- No index: the search counts shared keys over every live photo (see
-- keyCandidates in services/photos.ts and "Scale" in the README).
ALTER TABLE photos ADD COLUMN feature_keys integer[];
ALTER TABLE photos ADD COLUMN feature_x smallint[];
ALTER TABLE photos ADD COLUMN feature_y smallint[];
