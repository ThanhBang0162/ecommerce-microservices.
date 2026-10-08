# Kết quả kiểm thử demo

Ngày kiểm thử: 08/10/2026.
Môi trường: Docker Compose, API Gateway tại http://127.0.0.1:3002.

Bảng ghi nhận kết quả đã kiểm tra trong phiên demo.
Collection Postman hiện lưu 12 request; các trường hợp khác
được thực hiện thủ công trong phiên.

| STT | Trường hợp | Kết quả mong đợi | Kết quả ghi nhận |
|---|---|---|---|
| 1 | Health toàn hệ thống | HTTP 200, tất cả service UP | Đạt |
| 2 | Đăng ký khách hàng mới | Tạo tài khoản thành công | Đạt, UID 8 |
| 3 | Đăng ký trùng | Từ chối tài khoản trùng | Đạt |
| 4 | Đăng nhập khách hàng | HTTP 200, nhận JWT | Đạt |
| 5 | Đăng nhập sai mật khẩu | Từ chối đăng nhập | Đạt |
| 6 | Xác thực khách hàng | UID 8, CUSTOMER | Đạt |
| 7 | Tự tạo hồ sơ sau đăng ký | STANDARD, score 10 | Đạt |
| 8 | Đọc danh sách sản phẩm | Trả danh sách sản phẩm | Đạt |
| 9 | Tạo đơn mua 1 chuột | Giảm 25000, tổng 225000 | Đạt, OID 5 |
| 10 | Gửi lại cùng yêu cầu | Trả lại OID 5 | Đạt |
| 11 | Kiểm tra kho sau gửi lại | Chỉ giảm từ 45 xuống 44 | Đạt |
| 12 | Kafka tự tạo vận đơn | Vận đơn thuộc OID 5, UID 8 | Đạt, SID 5 |
| 13 | Khách cập nhật vận đơn | Bị từ chối | Đạt |
| 14 | Đăng nhập nhân viên | HTTP 200, nhận JWT | Đạt |
| 15 | Nhân viên chuyển sang IN_TRANSIT | Cập nhật thành công | Đạt |
| 16 | Nhân viên chuyển sang DELIVERED | Cập nhật thành công | Đạt |
| 17 | DELIVERED về IN_TRANSIT | Bị từ chối | Đạt |
| 18 | Xem đơn của người khác | Bị từ chối | Đạt |
| 19 | Danh sách đơn cá nhân | Chỉ có đơn của UID 8 | Đạt |
| 20 | Thiếu Bearer token | Bị từ chối | Đạt |
| 21 | Tạo đơn với qty 0 | Bị từ chối, kho vẫn 44 | Đạt |
| 22 | Import collection và dùng token khách | Biến customerToken hoạt động | Đạt |
| 23 | Dùng token nhân viên trong bản import | Kiểm tra trạng thái trả đúng lỗi | Đạt |

## Minh chứng

- [Khách bị chặn cập nhật vận đơn](evidence/shipment-customer-403.png)
- [Chặn chuyển ngược trạng thái](evidence/shipment-transition-409.png)

## Phạm vi

Đây là kết quả demo trên dữ liệu hiện có, chưa phải toàn bộ
bộ kiểm thử yêu cầu hoặc kiểm thử tải, đồng thời và chịu lỗi.