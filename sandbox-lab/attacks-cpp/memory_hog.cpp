#include <cstring>
#include <vector>
int main() {
    std::vector<char*> blocks;
    while (true) {
        char* p = new char[10000000];
        memset(p, 1, 10000000);
        blocks.push_back(p);
    }
}
