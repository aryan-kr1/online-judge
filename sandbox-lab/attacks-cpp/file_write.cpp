#include <cstdio>
int main() {
    const char* paths[] = {"/work/x", "/x", "/etc/x"};
    for (const char* p : paths) {
        FILE* f = fopen(p, "w");
        if (f) {
            printf("WROTE %s\n", p);
            fclose(f);
        } else {
            printf("blocked %s\n", p);
        }
    }
}
