-- Run this AFTER importing the pp table
ALTER TABLE map DROP COLUMN stars;
ALTER TABLE map DROP COLUMN pp;
ALTER TABLE map DROP COLUMN pp_aim;
ALTER TABLE map DROP COLUMN pp_acc;
ALTER TABLE map DROP COLUMN pp_fl;
ALTER TABLE map DROP COLUMN pp_speed;
ALTER TABLE map DROP COLUMN pp_strain;
ALTER TABLE map DROP COLUMN strain_aim;
ALTER TABLE map DROP COLUMN strain_speed;
DELETE FROM map WHERE map_id NOT IN (SELECT map_id FROM pp);
