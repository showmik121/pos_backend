-- মালিক দোকানের নাম বদলাতে পারে: শুধু stores.name-এ UPDATE (RLS পলিসি আগের মতো নিজের দোকানেই সীমিত)।
-- kind বদলানো যাবে না, তাই কলাম-স্তরের GRANT।
GRANT UPDATE (name) ON stores TO pos_app;
