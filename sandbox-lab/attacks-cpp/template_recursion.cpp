template <int N> struct T { static const int v = T<N - 1>::v + 1; };
template <> struct T<0> { static const int v = 0; };
int main() { return T<100000>::v; }
