-- Labor (category or name "Labor"/"Labour", as isLabor in shared/src/calc.js) is never test
-- data: it and its rate history survive clearing test data, even if added in test mode.
CREATE FUNCTION is_labor(name text, category text) RETURNS boolean LANGUAGE sql IMMUTABLE
  AS $$ SELECT lower(btrim(coalesce(category, ''))) IN ('labor', 'labour') OR lower(btrim(coalesce(name, ''))) IN ('labor', 'labour') $$;

CREATE FUNCTION labor_not_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ingredients' THEN
    IF is_labor(NEW.name, NEW.category) THEN NEW.is_test := false; END IF;
  ELSIF EXISTS (SELECT 1 FROM ingredients i WHERE i.id = NEW.ingredient_id AND is_labor(i.name, i.category)) THEN
    NEW.is_test := false;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER labor_not_test BEFORE INSERT OR UPDATE ON ingredients
  FOR EACH ROW EXECUTE FUNCTION labor_not_test();
CREATE TRIGGER labor_not_test BEFORE INSERT OR UPDATE ON ingredient_purchases
  FOR EACH ROW EXECUTE FUNCTION labor_not_test();

UPDATE ingredients SET is_test = false WHERE is_test AND is_labor(name, category);
UPDATE ingredient_purchases p SET is_test = false FROM ingredients i
  WHERE p.ingredient_id = i.id AND p.is_test AND is_labor(i.name, i.category);
